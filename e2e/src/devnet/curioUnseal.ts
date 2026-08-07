import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { envNumber } from "../runtime.js";
import { runRequired, sleep } from "../shell.js";
import {
  containerName,
  dockerExec,
  dockerExecEnv,
  dockerExecOk,
} from "./docker.js";

const FT_UNSEALED = 1;
const FT_SEALED = 2;
const ZIGZAG_DEVNET_ENV = "FIL_PROOFS_USE_ZIGZAG";
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = KIB * MIB;
const ZIGZAG_SUPPORTED_SECTOR_SIZES = new Set([2 * KIB, 8 * MIB]);

const REGISTERED_SEAL_PROOFS = new Map<number, { name: string; sectorSizeBytes: number }>([
  [0, { name: "StackedDrg2KiBV1", sectorSizeBytes: 2 * KIB }],
  [1, { name: "StackedDrg8MiBV1", sectorSizeBytes: 8 * MIB }],
  [2, { name: "StackedDrg512MiBV1", sectorSizeBytes: 512 * MIB }],
  [3, { name: "StackedDrg32GiBV1", sectorSizeBytes: 32 * GIB }],
  [4, { name: "StackedDrg64GiBV1", sectorSizeBytes: 64 * GIB }],
  [5, { name: "StackedDrg2KiBV1_1", sectorSizeBytes: 2 * KIB }],
  [6, { name: "StackedDrg8MiBV1_1", sectorSizeBytes: 8 * MIB }],
  [7, { name: "StackedDrg512MiBV1_1", sectorSizeBytes: 512 * MIB }],
  [8, { name: "StackedDrg32GiBV1_1", sectorSizeBytes: 32 * GIB }],
  [9, { name: "StackedDrg64GiBV1_1", sectorSizeBytes: 64 * GIB }],
  [10, { name: "StackedDrg2KiBV1_1_Feat_SyntheticPoRep", sectorSizeBytes: 2 * KIB }],
  [11, { name: "StackedDrg8MiBV1_1_Feat_SyntheticPoRep", sectorSizeBytes: 8 * MIB }],
  [12, { name: "StackedDrg512MiBV1_1_Feat_SyntheticPoRep", sectorSizeBytes: 512 * MIB }],
  [13, { name: "StackedDrg32GiBV1_1_Feat_SyntheticPoRep", sectorSizeBytes: 32 * GIB }],
  [14, { name: "StackedDrg64GiBV1_1_Feat_SyntheticPoRep", sectorSizeBytes: 64 * GIB }],
  [15, { name: "StackedDrg2KiBV1_2_Feat_NonInteractivePoRep", sectorSizeBytes: 2 * KIB }],
  [16, { name: "StackedDrg8MiBV1_2_Feat_NonInteractivePoRep", sectorSizeBytes: 8 * MIB }],
  [17, { name: "StackedDrg512MiBV1_2_Feat_NonInteractivePoRep", sectorSizeBytes: 512 * MIB }],
  [18, { name: "StackedDrg32GiBV1_2_Feat_NonInteractivePoRep", sectorSizeBytes: 32 * GIB }],
  [19, { name: "StackedDrg64GiBV1_2_Feat_NonInteractivePoRep", sectorSizeBytes: 64 * GIB }],
]);

export type ProofBackend = "sdr" | "zigzag";

export type ProofBackendInfo = {
  backend: ProofBackend;
  label: "SDR" | "ZigZag";
  registeredSealProof: number;
  registeredSealProofName: string;
  sectorSizeBytes?: number;
  reason: string;
  unsealPath: string;
};

export type CurioSectorPiece = {
  spId: number;
  sector: number;
  regSealProof: number;
  sectorOffset: number;
  pieceSize: number;
  rawSize: number;
  pieceCid: string;
};

export type CurioStorageState = {
  sealed: boolean;
  unsealed: boolean;
  targetUnsealState: boolean | null;
};

export type CurioUnsealPipeline = {
  taskIdUnsealSdr: number | null;
  afterUnsealSdr: boolean;
  taskIdDecodeSector: number | null;
  afterDecodeSector: boolean;
};

export type CurioIntegrityCheck = {
  checkId: number;
  expectedUnsealedCid: string;
  actualUnsealedCid: string;
  outputPath: string;
};

export type RecoveredPiece = {
  path: string;
  sha256: string;
  pieceCid: string;
  pieceSize: number;
  paddedBytesRead: number;
  rawBytesWritten: number;
  unsealedSectorBytes: number;
};

export type OnChainSectorInfo = {
  sector: number;
  activation: number;
  expiration: number;
  sealedCid: string;
};

export function resolveProofBackend(
  context: ScenarioContext,
  registeredSealProof: number,
): ProofBackendInfo {
  const curioZigZagEnv = dockerExec(context, "curio", [
    "sh", "-c", `printf '%s' "\${${ZIGZAG_DEVNET_ENV}:-}"`,
  ]).trim();
  return resolveProofBackendFromEnv(
    { ...context.config.env, [ZIGZAG_DEVNET_ENV]: curioZigZagEnv },
    registeredSealProof,
  );
}

export function resolveProofBackendFromEnv(
  env: Record<string, string | undefined>,
  registeredSealProof: number,
): ProofBackendInfo {
  const proof = REGISTERED_SEAL_PROOFS.get(registeredSealProof);
  const registeredSealProofName = proof?.name ?? `unknown(${registeredSealProof})`;
  const zigzagEnv = env[ZIGZAG_DEVNET_ENV] ?? "";
  const zigzagEnabled = truthyEnv(zigzagEnv);
  const supportedByZigZag = proof !== undefined
    && ZIGZAG_SUPPORTED_SECTOR_SIZES.has(proof.sectorSizeBytes);

  if (zigzagEnabled && supportedByZigZag) {
    return {
      backend: "zigzag",
      label: "ZigZag",
      registeredSealProof,
      registeredSealProofName,
      sectorSizeBytes: proof.sectorSizeBytes,
      reason: `${ZIGZAG_DEVNET_ENV}=${zigzagEnv} and ${registeredSealProofName} has a ZigZag-supported ${formatBytes(proof.sectorSizeBytes)} sector size`,
      unsealPath: "ZigZag filecoinffi.Unseal; SDRKeyRegen is skipped as a scheduler-compatible no-op",
    };
  }

  const reason = zigzagEnabled
    ? `${ZIGZAG_DEVNET_ENV}=${zigzagEnv} but ${registeredSealProofName} is not a ZigZag-supported devnet sector size`
    : `${ZIGZAG_DEVNET_ENV} is not enabled`;
  return {
    backend: "sdr",
    label: "SDR",
    registeredSealProof,
    registeredSealProofName,
    ...(proof === undefined ? {} : { sectorSizeBytes: proof.sectorSizeBytes }),
    reason,
    unsealPath: "StackedDRG SDRKeyRegen and DecodeSDR",
  };
}

export function unsealWaitStepName(proofBackend: ProofBackend): string {
  return proofBackend === "zigzag"
    ? "wait for ZigZag UnsealDecode with SDRKeyRegen skipped"
    : "wait for SDRKeyRegen and UnsealDecode";
}

export function parseSha256(output: string): string {
  const digest = output.match(/^([0-9a-f]{64})(?:\s|$)/m)?.[1];
  if (!digest) throw new Error(`command did not return a SHA256 digest: ${output.trim()}`);
  return digest;
}

export function parseCommp(output: string): { pieceCid: string; pieceSize: number } {
  const pieceCid = output.match(/^CommP CID:\s+(\S+)/m)?.[1];
  const pieceSize = Number(output.match(/^Piece size:\s+(\d+)/m)?.[1]);
  if (!pieceCid || !Number.isSafeInteger(pieceSize) || pieceSize <= 0) {
    throw new Error(`failed to parse CommP output:\n${output}`);
  }
  return { pieceCid, pieceSize };
}

export function readCurioSectorPiece(
  context: ScenarioContext,
  dealId: string,
  pieceCid: string,
): CurioSectorPiece {
  const row = queryScalar(
    context,
    `select json_build_object(` +
      `'spId',mpd.sp_id,'sector',mpd.sector_num,'regSealProof',sm.reg_seal_proof,` +
      `'sectorOffset',mpd.piece_offset,'pieceSize',mpd.piece_length,` +
      `'rawSize',mpd.raw_size,'pieceCid',mpd.piece_cid) ` +
      `from curio.market_piece_deal mpd ` +
      `join curio.sectors_meta sm on sm.sp_id=mpd.sp_id and sm.sector_num=mpd.sector_num ` +
      `where mpd.id='${sqlToken(dealId)}' and mpd.piece_cid='${sqlToken(pieceCid)}' limit 1`,
  );
  if (!row) throw new Error(`durable sector mapping not found for Curio deal ${dealId}`);
  return parseSectorPieceRow(row);
}

export function parseSectorPieceRow(row: string): CurioSectorPiece {
  const value = JSON.parse(row) as Partial<CurioSectorPiece>;
  for (const key of [
    "spId", "sector", "regSealProof", "sectorOffset", "pieceSize", "rawSize",
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw new Error(`invalid ${key} in Curio sector mapping: ${row}`);
    }
  }
  if (typeof value.pieceCid !== "string" || value.pieceCid.length === 0) {
    throw new Error(`invalid pieceCid in Curio sector mapping: ${row}`);
  }
  return value as CurioSectorPiece;
}

export function readCurioStorageState(
  context: ScenarioContext,
  spId: number,
  sector: number,
): CurioStorageState {
  const row = queryScalar(
    context,
    `select json_build_object(` +
      `'sealed',exists(select 1 from curio.sector_location where miner_id=${spId} and sector_num=${sector} and sector_filetype=${FT_SEALED}),` +
      `'unsealed',exists(select 1 from curio.sector_location where miner_id=${spId} and sector_num=${sector} and sector_filetype=${FT_UNSEALED}),` +
      `'targetUnsealState',target_unseal_state) ` +
      `from curio.sectors_meta where sp_id=${spId} and sector_num=${sector}`,
  );
  if (!row) throw new Error(`Curio sector metadata not found for ${spId}/${sector}`);
  const value = JSON.parse(row) as Partial<CurioStorageState>;
  if (typeof value.sealed !== "boolean" || typeof value.unsealed !== "boolean" ||
      !(value.targetUnsealState === null || typeof value.targetUnsealState === "boolean")) {
    throw new Error(`invalid Curio storage state: ${row}`);
  }
  return value as CurioStorageState;
}

export function readCurioUnsealPipeline(
  context: ScenarioContext,
  spId: number,
  sector: number,
): CurioUnsealPipeline | undefined {
  const row = queryScalar(
    context,
    `select json_build_object(` +
      `'taskIdUnsealSdr',task_id_unseal_sdr,'afterUnsealSdr',after_unseal_sdr,` +
      `'taskIdDecodeSector',task_id_decode_sector,'afterDecodeSector',after_decode_sector) ` +
      `from curio.sectors_unseal_pipeline where sp_id=${spId} and sector_number=${sector}`,
  );
  return row ? JSON.parse(row) as CurioUnsealPipeline : undefined;
}

export async function waitForSealedOnly(
  context: ScenarioContext,
  piece: CurioSectorPiece,
): Promise<CurioStorageState> {
  const timeoutSeconds = envNumber(context, "CURIO_FINALIZE_TIMEOUT_SECONDS", 600);
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 2) {
    const state = readCurioStorageState(context, piece.spId, piece.sector);
    if (state.sealed && !state.unsealed) return state;
    if (elapsed === 0 || elapsed % 30 === 0) {
      console.log(`  waiting for sealed-only storage state: ${JSON.stringify(state)}`);
    }
    await sleep(2000);
  }
  throw new Error(
    `sector ${piece.sector} did not reach sealed=yes, unsealed=no within ${timeoutSeconds} seconds`,
  );
}

export function setCurioUnsealTarget(
  context: ScenarioContext,
  provider: string,
  sector: number,
  target: boolean,
): string {
  return dockerExec(context, "curio", [
    "curio", "unseal", "set-target-state", provider, String(sector), String(target),
  ]);
}

export async function waitForCurioUnseal(
  context: ScenarioContext,
  piece: CurioSectorPiece,
  proofBackend: ProofBackend = "sdr",
): Promise<{ pipeline: CurioUnsealPipeline; storage: CurioStorageState }> {
  const timeoutSeconds = envNumber(context, "CURIO_UNSEAL_TIMEOUT_SECONDS", 7200);
  let sawSdrComplete = false;
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 2) {
    const pipeline = readCurioUnsealPipeline(context, piece.spId, piece.sector);
    const storage = readCurioStorageState(context, piece.spId, piece.sector);
    sawSdrComplete ||= pipeline?.afterUnsealSdr === true;
    if (pipeline?.afterDecodeSector && storage.unsealed) {
      return { pipeline, storage };
    }
    if (elapsed === 0 || elapsed % 30 === 0) {
      console.log(`  ${describeUnsealProgress(pipeline, storage, sawSdrComplete, proofBackend)}`);
    }
    await sleep(2000);
  }
  throw new Error(`Curio did not unseal sector ${piece.sector} within ${timeoutSeconds} seconds`);
}

export function describeUnsealProgress(
  pipeline: CurioUnsealPipeline | undefined,
  storage: CurioStorageState,
  sawSdrComplete = false,
  proofBackend: ProofBackend = "sdr",
): string {
  const keyStep = proofBackend === "zigzag" ? "ZigZag SDRKeyRegen skip" : "SDRKeyRegen";
  const decodeStep = proofBackend === "zigzag" ? "ZigZag UnsealDecode" : "UnsealDecode";
  if (!pipeline) return `waiting for unseal pipeline; FTUnsealed=${storage.unsealed}`;
  if (pipeline.taskIdUnsealSdr !== null) {
    return `${keyStep} running (task ${pipeline.taskIdUnsealSdr}); FTUnsealed=${storage.unsealed}`;
  }
  if (!pipeline.afterUnsealSdr && !sawSdrComplete) {
    return `${keyStep} waiting for scheduler; FTUnsealed=${storage.unsealed}`;
  }
  if (pipeline.taskIdDecodeSector !== null) {
    return `${decodeStep} running (task ${pipeline.taskIdDecodeSector}); FTUnsealed=${storage.unsealed}`;
  }
  if (!pipeline.afterDecodeSector) {
    return `${keyStep} complete; ${decodeStep} waiting for scheduler; FTUnsealed=${storage.unsealed}`;
  }
  return `${decodeStep} complete; FTUnsealed=${storage.unsealed}`;
}

export function readCurioUnsealInfo(
  context: ScenarioContext,
  provider: string,
  sector: number,
): string {
  return dockerExec(context, "curio", [
    "curio", "unseal", "info", provider, String(sector),
  ]);
}

export async function runCurioIntegrityCheck(
  context: ScenarioContext,
  provider: string,
  piece: CurioSectorPiece,
): Promise<CurioIntegrityCheck> {
  const baseline = Number(queryScalar(
    context,
    `select coalesce(max(check_id),0) from curio.scrub_unseal_commd_check ` +
      `where sp_id=${piece.spId} and sector_number=${piece.sector}`,
  ));
  const safeRunId = context.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const containerLog = `/tmp/${safeRunId}-unseal-check.log`;
  const outputPath = join(context.runDir, "unseal-check.log");
  const container = containerName("curio");

  runRequired("docker", [
    "exec", "-d", container,
    "sh", "-ec", "exec curio unseal check \"$1\" \"$2\" >\"$3\" 2>&1",
    "seal-unseal-check", provider, String(piece.sector), containerLog,
  ], context.projectRoot);

  const timeoutSeconds = envNumber(context, "CURIO_INTEGRITY_TIMEOUT_SECONDS", 1800);
  try {
    for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 2) {
      const row = queryScalar(
        context,
        `select json_build_object(` +
          `'checkId',check_id,'ok',ok,'expectedUnsealedCid',expected_unsealed_cid,` +
          `'actualUnsealedCid',actual_unsealed_cid,'message',message) ` +
          `from curio.scrub_unseal_commd_check ` +
          `where sp_id=${piece.spId} and sector_number=${piece.sector} and check_id>${baseline} ` +
          `order by check_id desc limit 1`,
      );
      if (row) {
        const value = JSON.parse(row) as {
          checkId: number;
          ok: boolean | null;
          expectedUnsealedCid: string;
          actualUnsealedCid: string | null;
          message: string | null;
        };
        if (value.ok !== null) {
          const output = readOptionalContainerFile(context, containerLog);
          writeFileSync(outputPath, output);
          if (!value.ok) {
            throw new Error(`Curio CommD integrity check failed: ${value.message ?? "unknown error"}`);
          }
          if (!value.actualUnsealedCid ||
              value.actualUnsealedCid !== value.expectedUnsealedCid) {
            throw new Error(
              `Curio CommD mismatch: ${value.actualUnsealedCid ?? "missing"} != ${value.expectedUnsealedCid}`,
            );
          }
          return {
            checkId: value.checkId,
            expectedUnsealedCid: value.expectedUnsealedCid,
            actualUnsealedCid: value.actualUnsealedCid,
            outputPath,
          };
        }
      }
      if (elapsed === 0 || elapsed % 30 === 0) {
        console.log(`  waiting for Curio CommD check${row ? " task" : " creation"}`);
      }
      await sleep(2000);
    }
    const output = readOptionalContainerFile(context, containerLog);
    writeFileSync(outputPath, output);
    throw new Error(`Curio CommD integrity check timed out after ${timeoutSeconds} seconds`);
  } finally {
    dockerExec(context, "curio", ["rm", "-f", "--", containerLog]);
  }
}

export function hashPieceSource(context: ScenarioContext, path: string): string {
  return parseSha256(dockerExec(context, "piece-server", ["sha256sum", "--", path]));
}

export function hashSealedSector(context: ScenarioContext, piece: CurioSectorPiece): string {
  return parseSha256(dockerExec(context, "curio", [
    "sha256sum", "--", readCurioSectorFilePath(context, piece, "sealed"),
  ]));
}

export function unsealedSectorSize(context: ScenarioContext, piece: CurioSectorPiece): number {
  return sectorFileSize(
    context,
    readCurioSectorFilePath(context, piece, "unsealed"),
  );
}

function sectorFileSize(context: ScenarioContext, sectorFilePath: string): number {
  const output = dockerExec(context, "curio", [
    "stat", "-c", "%s", "--", sectorFilePath,
  ]);
  const size = Number(output.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`invalid FTUnsealed size: ${output}`);
  }
  return size;
}

export function recoverPieceFromUnsealed(
  context: ScenarioContext,
  piece: CurioSectorPiece,
  artifactName = "recovered.car",
): RecoveredPiece {
  const maxUnpadded = Math.floor(piece.pieceSize / 128) * 127;
  if (piece.pieceSize <= 0 || piece.pieceSize % 128 !== 0 ||
      piece.rawSize <= 0 || piece.rawSize > maxUnpadded) {
    throw new Error(`invalid piece range for FTUnsealed recovery: ${JSON.stringify(piece)}`);
  }

  const unsealedPath = readCurioSectorFilePath(context, piece, "unsealed");
  const unsealedSectorBytes = sectorFileSize(context, unsealedPath);
  if (piece.sectorOffset + piece.pieceSize > unsealedSectorBytes) {
    throw new Error(
      `piece range exceeds the ${unsealedSectorBytes}-byte FTUnsealed file: ${JSON.stringify(piece)}`,
    );
  }

  const safeRunId = context.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeArtifactName = artifactName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const containerPath = `/tmp/${safeRunId}-${safeArtifactName}`;
  const recoveredPath = join(context.runDir, safeArtifactName);

  try {
    dockerExec(context, "curio", [
      "bash", "-ec",
      "set -o pipefail; dd if=\"$1\" of=\"$4.padded\" iflag=skip_bytes,count_bytes skip=\"$2\" count=\"$3\" status=none; lotus-shed fr32 --decode <\"$4.padded\" >\"$4.full\"; truncate -s \"$5\" \"$4.full\"; mv \"$4.full\" \"$4\"; rm -f -- \"$4.padded\"",
      "seal-unseal-recover", unsealedPath, String(piece.sectorOffset), String(piece.pieceSize),
      containerPath, String(piece.rawSize),
    ]);
    const sha256 = parseSha256(dockerExec(context, "curio", [
      "sha256sum", "--", containerPath,
    ]));
    const commp = parseCommp(dockerExecEnv(
      context,
      "curio",
      { SP_ADDRESS: context.config.provider },
      ["sptool", "toolbox", "mk12-client", "commp", containerPath],
    ));
    runRequired("docker", [
      "cp", `${containerName("curio")}:${containerPath}`, recoveredPath,
    ], context.projectRoot);
    const copiedSha256 = createHash("sha256").update(readFileSync(recoveredPath)).digest("hex");
    if (copiedSha256 !== sha256) {
      throw new Error(`recovered artifact changed during docker cp: ${copiedSha256} != ${sha256}`);
    }
    return {
      path: recoveredPath,
      sha256,
      pieceCid: commp.pieceCid,
      pieceSize: commp.pieceSize,
      paddedBytesRead: piece.pieceSize,
      rawBytesWritten: piece.rawSize,
      unsealedSectorBytes,
    };
  } finally {
    dockerExec(context, "curio", [
      "rm", "-f", "--", containerPath, `${containerPath}.full`, `${containerPath}.padded`,
    ]);
  }
}

export async function assertSectorCommitted(
  context: ScenarioContext,
  sector: number,
): Promise<OnChainSectorInfo> {
  const response = await fetch(context.config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "Filecoin.StateSectorGetInfo",
      params: [context.config.provider, sector, null],
    }),
  });
  const body = await response.json() as {
    result?: {
      SectorNumber?: number;
      Activation?: number;
      Expiration?: number;
      SealedCID?: { "/"?: string };
    } | null;
    error?: { message?: string };
  };
  const result = body.result;
  if (!response.ok || !result) {
    throw new Error(
      `StateSectorGetInfo did not find sector ${sector}: ${body.error?.message ?? response.status}`,
    );
  }
  if (
    result.SectorNumber !== sector
    || typeof result.Activation !== "number"
    || !Number.isSafeInteger(result.Activation)
    || typeof result.Expiration !== "number"
    || !Number.isSafeInteger(result.Expiration)
    || typeof result.SealedCID?.["/"] !== "string"
  ) {
    throw new Error(`StateSectorGetInfo returned invalid sector ${sector} data`);
  }
  return {
    sector,
    activation: result.Activation,
    expiration: result.Expiration,
    sealedCid: result.SealedCID["/"],
  };
}

function queryScalar(context: ScenarioContext, sql: string): string {
  return dockerExec(context, "yugabyte", [
    "ysqlsh", "-h", "yugabyte", "-U", "yugabyte", "-d", "yugabyte",
    "-At", "-c", sql,
  ]).trim();
}

function sqlToken(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`invalid database lookup token: ${value}`);
  return value;
}

function truthyEnv(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function formatBytes(value: number): string {
  if (value === 2 * KIB) return "2 KiB";
  if (value === 8 * MIB) return "8 MiB";
  if (value === 512 * MIB) return "512 MiB";
  if (value === 32 * GIB) return "32 GiB";
  if (value === 64 * GIB) return "64 GiB";
  return `${value} bytes`;
}

export function readCurioSectorFilePath(
  context: ScenarioContext,
  piece: Pick<CurioSectorPiece, "spId" | "sector">,
  type: "sealed" | "unsealed",
): string {
  if (!Number.isSafeInteger(piece.spId) || piece.spId < 0 ||
      !Number.isSafeInteger(piece.sector) || piece.sector < 0) {
    throw new Error(`invalid Curio sector coordinates: ${JSON.stringify(piece)}`);
  }

  const fileType = type === "sealed" ? FT_SEALED : FT_UNSEALED;
  const locationRows = queryScalar(
    context,
    `select storage_id from curio.sector_location ` +
      `where miner_id=${piece.spId} and sector_num=${piece.sector} ` +
      `and sector_filetype=${fileType} ` +
      `order by is_primary desc nulls last, storage_id`,
  );
  const storageIds = [...new Set(locationRows.split(/\r?\n/).filter(Boolean))];
  if (storageIds.length === 0) {
    throw new Error(`Curio ${type} location is not declared for ${piece.spId}/${piece.sector}`);
  }

  const storageRoots = readCurioLocalStorageRoots(context);
  const rootsById = new Map<string, string>();
  for (const root of storageRoots) {
    const metadataPath = posix.join(root, "sectorstore.json");
    if (!dockerExecOk(context, "curio", ["test", "-f", metadataPath])) {
      throw new Error(`Curio local storage metadata is missing: ${metadataPath}`);
    }
    const metadata = JSON.parse(
      dockerExec(context, "curio", ["cat", "--", metadataPath]),
    ) as { ID?: unknown };
    if (typeof metadata.ID !== "string" || metadata.ID.length === 0) {
      throw new Error(`Curio local storage metadata has no ID: ${metadataPath}`);
    }
    rootsById.set(metadata.ID, root);
  }

  const sectorName = `s-t0${piece.spId}-${piece.sector}`;
  for (const storageId of storageIds) {
    const root = rootsById.get(storageId);
    if (root === undefined) continue;
    const sectorFilePath = posix.join(root, type, sectorName);
    if (dockerExecOk(context, "curio", ["test", "-f", sectorFilePath])) {
      return sectorFilePath;
    }
  }

  throw new Error(
    `Curio ${type} file for ${piece.spId}/${piece.sector} is not available in local storage ` +
      `(declared storage IDs: ${storageIds.join(", ")})`,
  );
}

export function parseCurioStorageRoots(output: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Curio storage.json is not valid JSON");
  }
  const paths = value !== null && typeof value === "object"
    ? (value as { StoragePaths?: unknown }).StoragePaths
    : undefined;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("Curio storage.json has no StoragePaths");
  }
  return paths.map((entry) => {
    const path = entry !== null && typeof entry === "object"
      ? (entry as { Path?: unknown }).Path
      : undefined;
    if (typeof path !== "string" || !posix.isAbsolute(path)) {
      throw new Error("Curio storage.json contains a non-absolute storage path");
    }
    return path;
  });
}

function readCurioLocalStorageRoots(context: ScenarioContext): string[] {
  const repoPath = dockerExec(context, "curio", ["printenv", "CURIO_REPO_PATH"]).trim();
  if (!posix.isAbsolute(repoPath)) {
    throw new Error(`Curio returned an invalid CURIO_REPO_PATH: ${repoPath}`);
  }
  return parseCurioStorageRoots(dockerExec(context, "curio", [
    "cat", "--", posix.join(repoPath, "storage.json"),
  ]));
}

function readOptionalContainerFile(context: ScenarioContext, path: string): string {
  if (!dockerExecOk(context, "curio", ["test", "-f", path])) return "";
  return dockerExec(context, "curio", ["cat", "--", path]);
}
