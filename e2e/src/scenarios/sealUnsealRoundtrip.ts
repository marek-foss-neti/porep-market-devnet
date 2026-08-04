import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  assertSectorCommitted,
  type CurioSectorPiece,
  hashPieceSource,
  hashSealedSector,
  readCurioSectorPiece,
  readCurioStorageState,
  readCurioUnsealInfo,
  recoverPieceFromUnsealed,
  runCurioIntegrityCheck,
  setCurioUnsealTarget,
  waitForCurioUnseal,
  waitForSealedOnly,
} from "../devnet/curioUnseal.js";
import { submitCurioNotification, waitForCurioSector } from "../devnet/curio.js";
import { generatePieceAndAssertCommp, type PieceInfo } from "../devnet/piece.js";
import type { ScenarioContext } from "../runtime.js";
import { envValue, runStep } from "../runtime.js";

export async function runSealUnsealRoundtrip(context: ScenarioContext): Promise<void> {
  const resumeRunDir = envValue(context, "SEAL_UNSEAL_RESUME_RUN_DIR").trim();
  if (resumeRunDir) {
    await resumeSealUnsealRoundtrip(context, resumeRunDir);
    return;
  }

  const piece = await runStep(context, "generate fresh CAR and CommP", () =>
    generatePieceAndAssertCommp(context));
  const sourceSha256 = await runStep(context, "hash source CAR", () => {
    const sha256 = hashPieceSource(context, piece.pieceCarPath);
    context.state.set("SOURCE_SHA256", sha256);
    console.log(`  source SHA256: ${sha256}`);
    return { path: piece.pieceCarPath, sha256 };
  });
  const deal = await runStep(context, "submit fresh MK20 deal", () =>
    submitCurioNotification(context, piece, context.config.addresses.notificationReceiver));
  const pipeline = await runStep(context, "wait for seal and prove-commit", () =>
    waitForCurioSector(context, deal.dealId));
  const sectorPiece = await runStep(context, "resolve durable sector piece range", () => {
    const value = readCurioSectorPiece(context, deal.dealId, piece.pieceCid);
    assert.equal(value.sector, pipeline.sector);
    assert.equal(value.pieceCid, piece.pieceCid);
    assert.equal(value.pieceSize, Number(piece.pieceSize));
    assert.equal(value.spId, providerActorId(context.config.provider));
    context.state.set("CURIO_DEAL_ID", deal.dealId);
    context.state.set("ALLOC_ID", deal.allocationId);
    context.state.set("SECTOR_NUMBER", value.sector);
    context.state.set("SECTOR_OFFSET", value.sectorOffset);
    context.state.set("RAW_SIZE", value.rawSize);
    return value;
  });

  await runStep(context, "verify ProveCommit on-chain without waiting for WindowPoSt", async () => {
    const committed = await assertSectorCommitted(context, sectorPiece.sector);
    context.state.set("SECTOR_ACTIVATION_EPOCH", committed.activation);
    context.state.set("SECTOR_EXPIRATION_EPOCH", committed.expiration);
    console.log(
      `  sector ${committed.sector} is committed at epoch ${committed.activation}; `
        + "skipping first WindowPoSt",
    );
    return committed;
  });

  const sealedBaseline = await runStep(
    context,
    "assert sealed replica exists and unsealed replica is absent",
    async () => {
      const storage = await waitForSealedOnly(context, sectorPiece);
      const sealedSha256 = hashSealedSector(context, sectorPiece);
      const info = readCurioUnsealInfo(context, context.config.provider, sectorPiece.sector);
      context.state.set("SEALED_SHA256", sealedSha256);
      console.log(`  sealed SHA256: ${sealedSha256}`);
      console.log("  Curio reports FTSealed=yes and FTUnsealed=no");
      return { storage, sealedSha256, info };
    },
  );

  await runStep(context, "trigger Curio unseal target", () => {
    const output = setCurioUnsealTarget(
      context,
      context.config.provider,
      sectorPiece.sector,
      true,
    );
    console.log(`  ${output}`);
    return { output };
  });

  await runStep(context, "wait for SDRKeyRegen and UnsealDecode", () =>
    waitForCurioUnseal(context, sectorPiece));

  await verifyUnsealRoundtripTail(
    context,
    piece,
    sourceSha256.sha256,
    sealedBaseline.sealedSha256,
    sectorPiece,
  );
}

async function resumeSealUnsealRoundtrip(
  context: ScenarioContext,
  requestedRunDir: string,
): Promise<void> {
  const checkpoint = await runStep(context, "load seal-unseal checkpoint", () => {
    const runDir = resolve(requestedRunDir);
    assertRunDirWithinRoot(context, runDir);
    const statePath = join(runDir, "scenario.state.json");
    const state = parseCheckpointState(statePath);
    const piece: PieceInfo = {
      pieceCid: requireCheckpoint(state, "PIECE_CID", statePath),
      pieceCidV2: requireCheckpoint(state, "PIECE_CID_V2", statePath),
      pieceSize: BigInt(requireCheckpoint(state, "PIECE_SIZE", statePath)),
      pieceCidHex: requireCheckpoint(state, "PIECE_CID_HEX", statePath),
      pieceCarPath: requireCheckpoint(state, "PIECE_CAR_PATH", statePath),
    };
    const sourceSha256 = requireCheckpoint(state, "SOURCE_SHA256", statePath);
    const sealedSha256 = requireCheckpoint(state, "SEALED_SHA256", statePath);
    const dealId = requireCheckpoint(state, "CURIO_DEAL_ID", statePath);
    const sectorPiece = readCurioSectorPiece(context, dealId, piece.pieceCid);
    assert.equal(
      sectorPiece.sector,
      Number(requireCheckpoint(state, "SECTOR_NUMBER", statePath)),
      "checkpoint sector differs from Curio's durable deal mapping",
    );
    assert.equal(
      sectorPiece.sectorOffset,
      Number(requireCheckpoint(state, "SECTOR_OFFSET", statePath)),
      "checkpoint piece offset differs from Curio's durable deal mapping",
    );
    assert.equal(
      sectorPiece.rawSize,
      Number(requireCheckpoint(state, "RAW_SIZE", statePath)),
      "checkpoint raw size differs from Curio's durable deal mapping",
    );

    context.state.set("RESUMED_FROM", runDir);
    context.state.set("PIECE_CID", piece.pieceCid);
    context.state.set("PIECE_CID_V2", piece.pieceCidV2);
    context.state.set("PIECE_SIZE", piece.pieceSize);
    context.state.set("PIECE_CID_HEX", piece.pieceCidHex);
    context.state.set("PIECE_CAR_PATH", piece.pieceCarPath);
    context.state.set("SOURCE_SHA256", sourceSha256);
    context.state.set("SEALED_SHA256", sealedSha256);
    context.state.set("CURIO_DEAL_ID", dealId);
    context.state.set("SECTOR_NUMBER", sectorPiece.sector);
    context.state.set("SECTOR_OFFSET", sectorPiece.sectorOffset);
    context.state.set("RAW_SIZE", sectorPiece.rawSize);
    console.log(`  checkpoint: ${statePath}`);
    console.log(`  sector: ${context.config.provider}/${sectorPiece.sector}`);
    return { piece, sourceSha256, sealedSha256, sectorPiece };
  });

  await runStep(context, "verify resumed sector and source are unchanged", async () => {
    assert.equal(
      hashPieceSource(context, checkpoint.piece.pieceCarPath),
      checkpoint.sourceSha256,
      "source CAR changed since the checkpoint",
    );
    const storage = readCurioStorageState(
      context,
      checkpoint.sectorPiece.spId,
      checkpoint.sectorPiece.sector,
    );
    assert.equal(storage.sealed, true, "FTSealed is missing at resume time");
    assert.equal(storage.unsealed, true, "FTUnsealed is missing at resume time");
    assert.equal(storage.targetUnsealState, true, "unseal target is not enabled at resume time");
    assert.equal(
      hashSealedSector(context, checkpoint.sectorPiece),
      checkpoint.sealedSha256,
      "sealed replica changed since the checkpoint",
    );
    const committed = await assertSectorCommitted(context, checkpoint.sectorPiece.sector);
    const info = readCurioUnsealInfo(
      context,
      context.config.provider,
      checkpoint.sectorPiece.sector,
    );
    console.log("  source, FTSealed, FTUnsealed and on-chain commitment match the checkpoint");
    return { storage, committed, info };
  });

  await verifyUnsealRoundtripTail(
    context,
    checkpoint.piece,
    checkpoint.sourceSha256,
    checkpoint.sealedSha256,
    checkpoint.sectorPiece,
  );
}

async function verifyUnsealRoundtripTail(
  context: ScenarioContext,
  piece: PieceInfo,
  sourceSha256: string,
  sealedBaselineSha256: string,
  sectorPiece: CurioSectorPiece,
): Promise<void> {
  const integrity = await runStep(context, "verify unsealed CommD with Curio", () =>
    runCurioIntegrityCheck(context, context.config.provider, sectorPiece));
  context.state.set("UNSEAL_CHECK_ID", integrity.checkId);
  context.state.set("UNSEALED_CID", integrity.actualUnsealedCid);

  const recovered = await runStep(context, "recover exact piece bytes from FTUnsealed", () => {
    const result = recoverPieceFromUnsealed(context, sectorPiece);
    assert.equal(result.sha256, sourceSha256, "recovered CAR SHA256 differs from source");
    assert.equal(result.pieceCid, piece.pieceCid, "recovered CAR CommP differs from source");
    assert.equal(result.pieceSize, Number(piece.pieceSize), "recovered padded piece size differs");
    context.state.set("RECOVERED_CAR", result.path);
    context.state.set("RECOVERED_SHA256", result.sha256);
    console.log(`  recovered SHA256: ${result.sha256}`);
    console.log(`  recovered CommP:  ${result.pieceCid}`);
    return result;
  });

  await runStep(context, "verify sealed replica and on-chain sector remain unchanged", async () => {
    const storage = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
    assert.equal(storage.sealed, true, "FTSealed disappeared during unseal");
    assert.equal(storage.unsealed, true, "FTUnsealed disappeared after successful decode");
    assert.equal(storage.targetUnsealState, true, "Curio did not preserve the requested unseal target");
    const sealedSha256 = hashSealedSector(context, sectorPiece);
    assert.equal(
      sealedSha256,
      sealedBaselineSha256,
      "sealed replica changed during unseal",
    );
    const committed = await assertSectorCommitted(context, sectorPiece.sector);
    const info = readCurioUnsealInfo(context, context.config.provider, sectorPiece.sector);
    console.log("  sealed replica unchanged; sector remains committed on-chain");
    return {
      storage,
      sealedSha256,
      committed,
      recoveredSha256: recovered.sha256,
      info,
    };
  });
}

function assertRunDirWithinRoot(context: ScenarioContext, runDir: string): void {
  const runRoot = resolve(context.config.runRoot);
  const relativeRunDir = relative(runRoot, runDir);
  if (
    relativeRunDir === ".."
    || relativeRunDir.startsWith("../")
    || relativeRunDir.startsWith("..\\")
  ) {
    throw new Error(`seal-unseal checkpoint escapes the runtime root: ${runDir}`);
  }
}

function parseCheckpointState(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid seal-unseal checkpoint state: ${path}`);
  }
  return value as Record<string, unknown>;
}

function requireCheckpoint(
  state: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = state[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing or invalid ${key} in seal-unseal checkpoint: ${path}`);
  }
  return value;
}

function providerActorId(provider: string): number {
  const match = provider.match(/^t0(\d+)$/);
  if (!match) throw new Error(`expected ID-address provider, got ${provider}`);
  return Number(match[1]);
}
