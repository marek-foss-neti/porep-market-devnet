import assert from "node:assert/strict";
import {
  assertSectorCommitted,
  hashPieceSource,
  hashSealedSector,
  readCurioSectorPiece,
  readCurioStorageState,
  resolveProofBackend,
  setCurioUnsealTarget,
  waitForCurioUnseal,
  waitForSealedOnly,
  type CurioSectorPiece,
  type CurioStorageState,
  type ProofBackendInfo,
} from "../devnet/curioUnseal.js";
import { submitCurioNotification, waitForCurioSector } from "../devnet/curio.js";
import { generatePieceAndAssertCommp } from "../devnet/piece.js";
import {
  retrievePieceByHttp,
  type HttpRetrievalResult,
  type RetrievalMode,
} from "../devnet/retrieval.js";
import { withResourceMonitor } from "../devnet/resourceMetrics.js";
import type { ScenarioContext } from "../runtime.js";
import { envValue, runStep } from "../runtime.js";
import { recordProofBackend } from "./sealUnsealRoundtrip.js";

type RetrievalBenchMode = RetrievalMode | "both";

export async function runBenchRetrieval(context: ScenarioContext): Promise<void> {
  const modes = retrievalModes(context);
  context.state.set("BENCHMARK_KIND", "retrieval");
  context.state.set("RETRIEVAL_BENCH_MODES", modes.join(","));
  context.state.set(
    "RETRIEVAL_BENCH_SCOPE",
    "Curio HTTP /piece/{cid}; cold starts from FTUnsealed=false, hot starts from FTUnsealed=true",
  );
  context.state.set(
    "RETRIEVAL_BENCH_SOURCE_NOTE",
    "For MK20 deals Curio can satisfy /piece/{cid} from piece park before reading the sealed sector; compare storage-after state to tell whether the request created FTUnsealed.",
  );
  if (modes.length === 2) {
    context.state.set(
      "RETRIEVAL_BENCH_CAVEAT",
      "When cold and hot run in the same scenario, the hot retrieval can include Curio's successful piece-reader cache warmed by the cold request.",
    );
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
  const proofBackend = recordProofBackend(context, sectorPiece);

  await runStep(context, "verify ProveCommit on-chain without waiting for WindowPoSt", async () => {
    const committed = await assertSectorCommitted(context, sectorPiece.sector);
    context.state.set("SECTOR_ACTIVATION_EPOCH", committed.activation);
    context.state.set("SECTOR_EXPIRATION_EPOCH", committed.expiration);
    return committed;
  });

  await runStep(context, "prepare cold retrieval sealed-only baseline", async () => {
    const storage = await ensureSealedOnly(context, sectorPiece);
    const sealedSha256 = hashSealedSector(context, sectorPiece);
    context.state.set("SEALED_SHA256", sealedSha256);
    console.log(`  sealed SHA256: ${sealedSha256}`);
    return { storage, sealedSha256 };
  });

  if (modes.includes("cold")) {
    await runStep(context, "bench cold retrieval via Curio HTTP /piece", async () =>
      runRetrievalBench(context, "cold", piece.pieceCid, sourceSha256.sha256, sectorPiece));
  }

  if (modes.includes("hot")) {
    await runStep(context, "prepare hot retrieval unsealed copy", async () =>
      ensureHotUnsealedCopy(context, sectorPiece, proofBackend));
    await runStep(context, "bench hot retrieval via Curio HTTP /piece", async () =>
      runRetrievalBench(context, "hot", piece.pieceCid, sourceSha256.sha256, sectorPiece));
  }
}

function retrievalModes(context: ScenarioContext): RetrievalMode[] {
  const value = envValue(context, "RETRIEVAL_BENCH_MODE", "both").trim().toLowerCase();
  if (value === "both" || value === "") return ["cold", "hot"];
  if (value === "cold" || value === "hot") return [value];
  throw new Error(`invalid RETRIEVAL_BENCH_MODE=${value}; expected cold, hot, or both`);
}

async function runRetrievalBench(
  context: ScenarioContext,
  mode: RetrievalMode,
  pieceCid: string,
  expectedSha256: string,
  sectorPiece: CurioSectorPiece,
): Promise<{
  result: HttpRetrievalResult;
  before: CurioStorageState;
  after: CurioStorageState;
}> {
  const before = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  if (mode === "cold") {
    assert.equal(before.sealed, true, "cold retrieval requires FTSealed");
    assert.equal(before.unsealed, false, "cold retrieval requires FTUnsealed=false before the request");
  } else {
    assert.equal(before.unsealed, true, "hot retrieval requires FTUnsealed=true before the request");
  }

  const result = await withResourceMonitor(
    context,
    `retrieval-${mode}`,
    `RETRIEVAL_${mode}`,
    () => retrievePieceByHttp(context, pieceCid, mode),
  );
  assert.equal(result.sha256, expectedSha256, `${mode} retrieval SHA256 differs from source`);
  recordRetrievalState(context, mode, result, expectedSha256, before);
  const after = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  context.state.set(`RETRIEVAL_${mode.toUpperCase()}_STORAGE_AFTER`, storageStateLabel(after));
  console.log(
    `  ${mode} retrieval: ${result.bytes} bytes in ${Math.round(result.totalMs)}ms; `
      + `SHA256=${result.sha256}`,
  );
  return { result, before, after };
}

async function ensureSealedOnly(
  context: ScenarioContext,
  sectorPiece: CurioSectorPiece,
): Promise<CurioStorageState> {
  const storage = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  if (storage.unsealed || storage.targetUnsealState === true) {
    const output = setCurioUnsealTarget(context, context.config.provider, sectorPiece.sector, false);
    console.log(`  ${output}`);
  }
  return waitForSealedOnly(context, sectorPiece);
}

async function ensureHotUnsealedCopy(
  context: ScenarioContext,
  sectorPiece: CurioSectorPiece,
  proofBackend: ProofBackendInfo,
): Promise<{ before: CurioStorageState; after: CurioStorageState }> {
  const before = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  if (!before.unsealed || before.targetUnsealState !== true) {
    const output = setCurioUnsealTarget(context, context.config.provider, sectorPiece.sector, true);
    console.log(`  ${output}`);
  }
  if (!before.unsealed) {
    await waitForCurioUnseal(context, sectorPiece, proofBackend.backend);
  }
  const after = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  assert.equal(after.unsealed, true, "hot retrieval preparation did not leave FTUnsealed=true");
  context.state.set("RETRIEVAL_HOT_UNSEAL_PREP_STORAGE", storageStateLabel(after));
  return { before, after };
}

function recordRetrievalState(
  context: ScenarioContext,
  mode: RetrievalMode,
  result: HttpRetrievalResult,
  expectedSha256: string,
  before: CurioStorageState,
): void {
  const prefix = `RETRIEVAL_${mode.toUpperCase()}`;
  context.state.set(`${prefix}_HTTP_STATUS`, result.status);
  context.state.set(`${prefix}_URL`, result.url);
  context.state.set(`${prefix}_BYTES`, result.bytes);
  context.state.set(`${prefix}_TTFB_MS`, formatMetric(result.ttfbMs));
  context.state.set(`${prefix}_TOTAL_MS`, formatMetric(result.totalMs));
  context.state.set(`${prefix}_THROUGHPUT_BYTES_PER_SECOND`, formatMetric(result.throughputBytesPerSecond));
  context.state.set(`${prefix}_SHA256`, result.sha256);
  context.state.set(`${prefix}_SHA256_MATCH`, String(result.sha256 === expectedSha256));
  context.state.set(`${prefix}_OUTPUT`, result.outputPath);
  context.state.set(`${prefix}_CONTENT_TYPE`, result.contentType);
  context.state.set(`${prefix}_ETAG`, result.etag);
  context.state.set(`${prefix}_STORAGE_BEFORE`, storageStateLabel(before));
}

function storageStateLabel(storage: CurioStorageState): string {
  return `sealed=${storage.sealed},unsealed=${storage.unsealed},target=${storage.targetUnsealState}`;
}

function formatMetric(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function providerActorId(provider: string): number {
  const match = provider.match(/^t0(\d+)$/);
  if (!match) throw new Error(`expected ID-address provider, got ${provider}`);
  return Number(match[1]);
}
