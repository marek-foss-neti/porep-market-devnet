import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertSectorCommitted,
  hashPieceSource,
  hashSealedSector,
  readCurioSectorPiece,
  readCurioStorageState,
  recoverPieceFromUnsealed,
  runCurioIntegrityCheck,
  setCurioUnsealTarget,
  unsealWaitStepName,
  waitForCurioUnseal,
  waitForSealedOnly,
  type CurioSectorPiece,
  type CurioStorageState,
  type ProofBackendInfo,
  type RecoveredPiece,
} from "../devnet/curioUnseal.js";
import { dockerExecOk } from "../devnet/docker.js";
import { submitCurioNotification, waitForCurioSector } from "../devnet/curio.js";
import { generatePieceAndAssertCommp, type PieceInfo } from "../devnet/piece.js";
import {
  retrievePieceByHttp,
  type HttpRetrievalResult,
  type RetrievalMode,
} from "../devnet/retrieval.js";
import { withResourceMonitor } from "../devnet/resourceMetrics.js";
import type { ScenarioContext } from "../runtime.js";
import { envNumber, runStep } from "../runtime.js";
import { run, runRequired, sleep } from "../shell.js";
import { recordProofBackend } from "./sealUnsealRoundtrip.js";

export type DeliverSealUnsealRetrievalOptions = {
  benchmark?: boolean;
};

type DeliveredPiece = {
  piece: PieceInfo;
  sourceSha256: string;
  dealId: string;
  allocationId: bigint;
};

export async function runDeliverSealUnsealRetrieval(
  context: ScenarioContext,
  options: DeliverSealUnsealRetrievalOptions = {},
): Promise<void> {
  context.state.set("DEVNET_PROOF_BACKEND", context.config.proofBackend);
  if (options.benchmark) {
    context.state.set("BENCHMARK_KIND", "deliver-seal-unseal-retrieval");
    context.state.set("BENCH_ISOLATION", "fresh-devnet");
    context.state.set(
      "DELIVER_RETRIEVAL_BENCH_SCOPE",
      "fresh MK20 delivery through seal/prove, cold HTTP retrieval, unseal, forced sector retrieval, and hot retrieval",
    );
    context.state.set(
      "RETRIEVAL_BENCH_SOURCE_NOTE",
      "HTTP /piece/{cid} can be satisfied from piece park for MK20; forced sector retrieval reads recovered bytes from FTUnsealed.",
    );
    context.state.set(
      "RETRIEVAL_CACHE_ISOLATION",
      "fresh devnet per backend; Curio service restart before each measured HTTP request; forced sector paths bypass HTTP request cache",
    );
    recordBenchmarkEnvironment(context);
  }

  const delivered = await runStep(context, "deliver fresh CAR through MK20 notification", () =>
    maybeMonitor(context, options, "deliver", "DELIVER", async () => {
      const piece = await generatePieceAndAssertCommp(context);
      const sourceSha256 = hashPieceSource(context, piece.pieceCarPath);
      context.state.set("SOURCE_SHA256", sourceSha256);
      console.log(`  source SHA256: ${sourceSha256}`);
      const deal = await submitCurioNotification(
        context,
        piece,
        context.config.addresses.notificationReceiver,
      );
      context.state.set("CURIO_DEAL_ID", deal.dealId);
      context.state.set("ALLOC_ID", deal.allocationId);
      return { piece, sourceSha256, dealId: deal.dealId, allocationId: deal.allocationId };
    }));

  const sealed = await runStep(context, "seal and prove-commit delivered piece", () =>
    maybeMonitor(context, options, "seal-prove", "SEAL_PROVE", async () => {
      const pipeline = await waitForCurioSector(context, delivered.dealId);
      const sectorPiece = readCurioSectorPiece(context, delivered.dealId, delivered.piece.pieceCid);
      assert.equal(sectorPiece.sector, pipeline.sector);
      assert.equal(sectorPiece.pieceCid, delivered.piece.pieceCid);
      assert.equal(sectorPiece.pieceSize, Number(delivered.piece.pieceSize));
      assert.equal(sectorPiece.spId, providerActorId(context.config.provider));
      context.state.set("SECTOR_NUMBER", sectorPiece.sector);
      context.state.set("SECTOR_OFFSET", sectorPiece.sectorOffset);
      context.state.set("RAW_SIZE", sectorPiece.rawSize);
      const proofBackend = recordProofBackend(context, sectorPiece);
      const committed = await assertSectorCommitted(context, sectorPiece.sector);
      context.state.set("SECTOR_ACTIVATION_EPOCH", committed.activation);
      context.state.set("SECTOR_EXPIRATION_EPOCH", committed.expiration);
      const storage = await waitForSealedOnly(context, sectorPiece);
      const sealedSha256 = hashSealedSector(context, sectorPiece);
      context.state.set("SEALED_SHA256", sealedSha256);
      console.log(`  sealed SHA256: ${sealedSha256}`);
      return { sectorPiece, proofBackend, sealedSha256, storage };
    }));

  await isolateHttpRetrievalCache(context, options, "cold", "RETRIEVAL_HTTP_COLD");
  await runStep(context, "bench cold HTTP retrieval via Curio /piece", () =>
    maybeMonitor(context, options, "retrieval-http-cold", "RETRIEVAL_HTTP_COLD", async () =>
      runHttpRetrieval(
        context,
        "cold",
        "RETRIEVAL_HTTP_COLD",
        delivered.piece.pieceCid,
        delivered.sourceSha256,
        sealed.sectorPiece,
      )));

  await runStep(context, unsealWaitStepName(sealed.proofBackend.backend), () =>
    maybeMonitor(context, options, "unseal", "UNSEAL", async () => {
      const output = setCurioUnsealTarget(
        context,
        context.config.provider,
        sealed.sectorPiece.sector,
        true,
      );
      console.log(`  ${output}`);
      await waitForCurioUnseal(context, sealed.sectorPiece, sealed.proofBackend.backend);
      return readCurioStorageState(context, sealed.sectorPiece.spId, sealed.sectorPiece.sector);
    }));

  await runStep(context, "verify unsealed CommD with Curio", async () => {
    const integrity = await runCurioIntegrityCheck(context, context.config.provider, sealed.sectorPiece);
    context.state.set("UNSEAL_CHECK_ID", integrity.checkId);
    context.state.set("UNSEALED_CID", integrity.actualUnsealedCid);
    return integrity;
  });

  await runStep(context, "bench forced sector retrieval after cold unseal", () =>
    maybeMonitor(context, options, "retrieval-sector-cold", "RETRIEVAL_SECTOR_COLD", () =>
      runSectorRetrieval(
        context,
        "RETRIEVAL_SECTOR_COLD",
        "retrieved-sector-cold.car",
        delivered.piece,
        delivered.sourceSha256,
        sealed.sectorPiece,
      )));

  await isolateHttpRetrievalCache(context, options, "hot", "RETRIEVAL_HTTP_HOT");
  await runStep(context, "bench hot HTTP retrieval via Curio /piece", () =>
    maybeMonitor(context, options, "retrieval-http-hot", "RETRIEVAL_HTTP_HOT", async () =>
      runHttpRetrieval(
        context,
        "hot",
        "RETRIEVAL_HTTP_HOT",
        delivered.piece.pieceCid,
        delivered.sourceSha256,
        sealed.sectorPiece,
      )));

  await runStep(context, "bench hot forced sector retrieval from FTUnsealed", () =>
    maybeMonitor(context, options, "retrieval-sector-hot", "RETRIEVAL_SECTOR_HOT", () =>
      runSectorRetrieval(
        context,
        "RETRIEVAL_SECTOR_HOT",
        "retrieved-sector-hot.car",
        delivered.piece,
        delivered.sourceSha256,
        sealed.sectorPiece,
      )));

  await runStep(context, "verify sealed replica and on-chain sector remain unchanged", async () => {
    const storage = readCurioStorageState(context, sealed.sectorPiece.spId, sealed.sectorPiece.sector);
    assert.equal(storage.sealed, true, "FTSealed disappeared during retrieval");
    assert.equal(storage.unsealed, true, "FTUnsealed disappeared after retrieval");
    assert.equal(hashSealedSector(context, sealed.sectorPiece), sealed.sealedSha256);
    const committed = await assertSectorCommitted(context, sealed.sectorPiece.sector);
    return { storage, committed };
  });
}

export async function runBenchDeliverSealUnsealRetrieval(context: ScenarioContext): Promise<void> {
  await runDeliverSealUnsealRetrieval(context, { benchmark: true });
}

async function maybeMonitor<T>(
  context: ScenarioContext,
  options: DeliverSealUnsealRetrievalOptions,
  scope: string,
  statePrefix: string,
  action: () => T | Promise<T>,
): Promise<T> {
  if (!options.benchmark) return await action();
  return await withResourceMonitor(context, scope, statePrefix, action);
}

async function isolateHttpRetrievalCache(
  context: ScenarioContext,
  options: DeliverSealUnsealRetrievalOptions,
  mode: RetrievalMode,
  prefix: string,
): Promise<void> {
  if (!options.benchmark) return;
  await runStep(context, `isolate Curio request cache before ${mode} HTTP retrieval`, async () => {
    runRequired("bash", [
      "-c",
      "source \"$1\"; devnet_compose restart curio >/dev/null",
      "curio-cache-isolation",
      join(context.projectRoot, "scripts/devnet-common.sh"),
    ], context.projectRoot);
    await waitForCurioReadyAfterRestart(context);
    context.state.set(`${prefix}_CACHE_ISOLATION`, "curio-service-restarted-before-measured-request");
    return { mode, service: "curio" };
  });
}

async function waitForCurioReadyAfterRestart(context: ScenarioContext): Promise<void> {
  const timeoutSeconds = envNumber(context, "CURIO_RESTART_TIMEOUT_SECONDS", 300);
  const baseUrl = (context.config.env.CURIO_RETRIEVAL_BASE_URL
    ?? process.env.CURIO_RETRIEVAL_BASE_URL
    ?? "http://127.0.0.1:22310").replace(/\/+$/g, "");
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 2) {
    const apiReady = dockerExecOk(context, "curio", ["curio", "cli", "--machine", "curio:12300", "info"]);
    const marketReady = await httpHealthOk(`${baseUrl}/health`);
    if (apiReady && marketReady) return;
    if (elapsed === 0 || elapsed % 30 === 0) {
      console.log(`  waiting for Curio restart readiness: api=${apiReady} market=${marketReady}`);
    }
    await sleep(2000);
  }
  throw new Error(`Curio did not become ready after restart within ${timeoutSeconds} seconds`);
}

async function httpHealthOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok && (await response.text()) === "Service is up and running";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function runHttpRetrieval(
  context: ScenarioContext,
  mode: RetrievalMode,
  prefix: string,
  pieceCid: string,
  expectedSha256: string,
  sectorPiece: CurioSectorPiece,
): Promise<{ result: HttpRetrievalResult; before: CurioStorageState; after: CurioStorageState }> {
  const before = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  if (mode === "cold") {
    assert.equal(before.sealed, true, "cold HTTP retrieval requires FTSealed");
    assert.equal(before.unsealed, false, "cold HTTP retrieval requires FTUnsealed=false before the request");
  } else {
    assert.equal(before.unsealed, true, "hot HTTP retrieval requires FTUnsealed=true before the request");
  }
  const result = await retrievePieceByHttp(context, pieceCid, mode);
  assert.equal(result.sha256, expectedSha256, `${mode} HTTP retrieval SHA256 differs from source`);
  const after = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  recordHttpRetrievalState(context, prefix, result, expectedSha256, before, after);
  console.log(
    `  ${mode} HTTP retrieval: ${result.bytes} bytes in ${Math.round(result.totalMs)}ms; `
      + `SHA256=${result.sha256}`,
  );
  return { result, before, after };
}

function runSectorRetrieval(
  context: ScenarioContext,
  prefix: string,
  artifactName: string,
  piece: PieceInfo,
  expectedSha256: string,
  sectorPiece: CurioSectorPiece,
): { recovered: RecoveredPiece; before: CurioStorageState; after: CurioStorageState } {
  const before = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  assert.equal(before.unsealed, true, "forced sector retrieval requires FTUnsealed=true");
  const recovered = recoverPieceFromUnsealed(context, sectorPiece, artifactName);
  assert.equal(recovered.sha256, expectedSha256, "forced sector retrieval SHA256 differs from source");
  assert.equal(recovered.pieceCid, piece.pieceCid, "forced sector retrieval CommP differs from source");
  assert.equal(recovered.pieceSize, Number(piece.pieceSize), "forced sector retrieval padded size differs");
  const after = readCurioStorageState(context, sectorPiece.spId, sectorPiece.sector);
  recordSectorRetrievalState(context, prefix, recovered, expectedSha256, before, after);
  if (prefix === "RETRIEVAL_SECTOR_COLD") {
    context.state.set("RECOVERED_CAR", recovered.path);
    context.state.set("RECOVERED_SHA256", recovered.sha256);
  }
  console.log(`  forced sector retrieval: ${recovered.rawBytesWritten} bytes; SHA256=${recovered.sha256}`);
  return { recovered, before, after };
}

function recordHttpRetrievalState(
  context: ScenarioContext,
  prefix: string,
  result: HttpRetrievalResult,
  expectedSha256: string,
  before: CurioStorageState,
  after: CurioStorageState,
): void {
  context.state.set(`${prefix}_KIND`, "http-piece");
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
  context.state.set(`${prefix}_STORAGE_AFTER`, storageStateLabel(after));
}

function recordSectorRetrievalState(
  context: ScenarioContext,
  prefix: string,
  result: RecoveredPiece,
  expectedSha256: string,
  before: CurioStorageState,
  after: CurioStorageState,
): void {
  context.state.set(`${prefix}_KIND`, "forced-sector");
  context.state.set(`${prefix}_BYTES`, result.rawBytesWritten);
  context.state.set(`${prefix}_PADDED_BYTES_READ`, result.paddedBytesRead);
  context.state.set(`${prefix}_UNSEALED_SECTOR_BYTES`, result.unsealedSectorBytes);
  context.state.set(`${prefix}_SHA256`, result.sha256);
  context.state.set(`${prefix}_SHA256_MATCH`, String(result.sha256 === expectedSha256));
  context.state.set(`${prefix}_OUTPUT`, result.path);
  context.state.set(`${prefix}_PIECE_CID`, result.pieceCid);
  context.state.set(`${prefix}_PIECE_SIZE`, result.pieceSize);
  context.state.set(`${prefix}_STORAGE_BEFORE`, storageStateLabel(before));
  context.state.set(`${prefix}_STORAGE_AFTER`, storageStateLabel(after));
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

function recordBenchmarkEnvironment(context: ScenarioContext): void {
  recordStatusSnapshot(context);
  recordBuildManifestSnapshot(context);
  recordProofParameterCache(context);
  recordDockerSnapshot(context);
}

function recordStatusSnapshot(context: ScenarioContext): void {
  const statusPath = join(context.projectRoot, ".runtime/devnet/status/latest.json");
  const status = readJsonRecord(statusPath);
  if (status === undefined) return;
  const proof = asRecord(status.proof);
  const lotusProof = asRecord(proof?.lotus);
  const curioProof = asRecord(proof?.curio);
  recordString(context, "STATUS_PROOF_BACKEND", proof?.backend);
  recordString(context, "STATUS_LOTUS_FIL_PROOFS_USE_ZIGZAG", lotusProof?.FIL_PROOFS_USE_ZIGZAG);
  recordString(context, "STATUS_CURIO_FIL_PROOFS_USE_ZIGZAG", curioProof?.FIL_PROOFS_USE_ZIGZAG);
  recordString(
    context,
    "STATUS_CURIO_FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS",
    curioProof?.FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS,
  );
  const build = asRecord(status.build);
  recordString(context, "STATUS_CURIO_COMMIT", build?.curioCommit);
  recordString(context, "STATUS_LOTUS_COMMIT", build?.lotusCommit);
  recordString(context, "STATUS_IMAGE_PLATFORM", build?.platform);
}

function recordBuildManifestSnapshot(context: ScenarioContext): void {
  const manifestPath = join(context.projectRoot, ".runtime/devnet/build/images.json");
  const manifest = readJsonRecord(manifestPath);
  if (manifest === undefined) return;
  context.state.set("DEVNET_BUILD_MANIFEST", manifestPath);
  recordString(context, "DEVNET_IMAGE_NAMESPACE", manifest.namespace);
  recordString(context, "DEVNET_IMAGE_TAG", manifest.tag);
  recordString(context, "DEVNET_IMAGE_PLATFORM", manifest.platform);
  recordString(context, "DEVNET_CURIO_COMMIT", manifest.curioCommit);
  recordString(context, "DEVNET_LOTUS_COMMIT", manifest.lotusCommit);
  recordString(context, "DEVNET_BLST_COMMIT", manifest.blstCommit);
  recordString(context, "DEVNET_ZIGZAG_FILECOIN_FFI_PATCH_SHA256", manifest.zigzagFilecoinFfiPatchSha256);
  recordString(context, "DEVNET_ZIGZAG_RUST_FIL_PROOFS_API_SHA256", manifest.zigzagRustFilProofsApiSha256);

  const images = Array.isArray(manifest.images) ? manifest.images.map(asRecord).filter(isDefined) : [];
  recordImage(context, images, "curio", "IMAGE_CURIO");
  recordImage(context, images, "lotus", "IMAGE_LOTUS");
  recordImage(context, images, "lotus-miner", "IMAGE_LOTUS_MINER");
  recordImage(context, images, "piece-server", "IMAGE_PIECE_SERVER");
}

function recordImage(
  context: ScenarioContext,
  images: Array<Record<string, unknown>>,
  imageName: string,
  prefix: string,
): void {
  const image = images.find((candidate) =>
    typeof candidate.reference === "string" && candidate.reference.includes(`/${imageName}:`));
  if (image === undefined) return;
  recordString(context, `${prefix}_REFERENCE`, image.reference);
  recordString(context, `${prefix}_ID`, image.id);
}

function recordProofParameterCache(context: ScenarioContext): void {
  const directory = join(context.projectRoot, ".cache/proof-parameters");
  context.state.set("PROOF_PARAMETERS_DIR", directory);
  if (!existsSync(directory)) {
    context.state.set("PROOF_PARAMETER_CACHE_STATUS", "missing");
    context.state.set("PROOF_PARAMETER_CACHE_FILE_COUNT", 0);
    context.state.set("PROOF_PARAMETER_CACHE_BYTES", 0);
    return;
  }
  const summary = summarizeDirectory(directory);
  context.state.set("PROOF_PARAMETER_CACHE_STATUS", summary.fileCount === 0 ? "empty" : "present");
  context.state.set("PROOF_PARAMETER_CACHE_FILE_COUNT", summary.fileCount);
  context.state.set("PROOF_PARAMETER_CACHE_BYTES", summary.bytes);
}

function recordDockerSnapshot(context: ScenarioContext): void {
  const result = run("docker", ["info", "--format", "{{json .}}"], context.projectRoot);
  if (result.status !== 0) {
    context.state.set("DOCKER_INFO_STATUS", result.status);
    return;
  }
  const info = parseJsonRecord(result.stdout, "docker info");
  if (info === undefined) return;
  recordString(context, "DOCKER_SERVER_VERSION", info.ServerVersion);
  recordNumber(context, "DOCKER_CPU_COUNT", info.NCPU);
  recordNumber(context, "DOCKER_TOTAL_MEMORY_BYTES", info.MemTotal);
  recordString(context, "DOCKER_OPERATING_SYSTEM", info.OperatingSystem);
  recordString(context, "DOCKER_ARCHITECTURE", info.Architecture);
}

function summarizeDirectory(directory: string): { fileCount: number; bytes: number } {
  let fileCount = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const child = summarizeDirectory(path);
      fileCount += child.fileCount;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      const stat = statSync(path);
      fileCount += 1;
      bytes += stat.size;
    }
  }
  return { fileCount, bytes };
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return parseJsonRecord(readFileSync(path, "utf8"), path);
}

function parseJsonRecord(source: string, label: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(source));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordString(context: ScenarioContext, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) context.state.set(key, value);
}

function recordNumber(context: ScenarioContext, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) context.state.set(key, value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
