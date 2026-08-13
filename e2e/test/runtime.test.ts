import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { E2EConfig } from "../src/config.js";
import {
  createScenarioContext,
  runStep,
  writeRunSummary,
} from "../src/runtime.js";

test("failed scenario summary binds the run to one deployment revision", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "scenario-runtime-"));
  const context = createScenarioContext(config(runDir), runDir, "run-test");
  await assert.rejects(
    runStep(context, "failing action", () => {
      throw new Error("expected failure");
    }),
    /expected failure/,
  );
  const diagnosticsPath = join(runDir, "failure-diagnostics.log");
  writeFileSync(diagnosticsPath, "diagnostic evidence\n");
  context.state.set("FAILURE_DIAGNOSTICS", diagnosticsPath);
  const summaryPath = writeRunSummary(context, "failed", new Error("expected failure"));
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
  assert.equal(summary.result, "failed");
  assert.equal(summary.runId, "run-test");
  assert.equal(summary.deploymentId, "deployment-test");
  assert.equal(summary.deploymentRevision, 2);
  assert.equal(summary.error, "expected failure");
  assert.equal(typeof summary.startedAt, "string");
  assert.equal(typeof summary.durationMs, "number");
  const stepResults = summary.stepResults as Array<Record<string, unknown>>;
  assert.equal(stepResults.length, 1);
  assert.deepEqual(
    { ...stepResults[0], elapsedMs: 0 },
    {
      index: 1,
      name: "failing action",
      status: "failed",
      elapsedMs: 0,
      artifact: "01-failing-action.error.json",
      error: "expected failure",
    },
  );
  assert.equal(typeof stepResults[0]?.elapsedMs, "number");

  const reportPath = join(runDir, "summary.md");
  assert.equal(existsSync(reportPath), true);
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /❌ \*\*FAILED\*\*/);
  assert.match(report, /step 1 failed: \*\*failing action\*\*/);
  assert.match(report, /expected failure/);
  assert.match(report, /01-failing-action\.error\.json/);
  assert.match(report, /failure-diagnostics\.log/);
});

test("successful seal-unseal summary produces a descriptive Markdown verdict", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "scenario-runtime-"));
  const context = createScenarioContext(
    config(runDir),
    runDir,
    "run-seal-unseal",
    "seal-unseal-roundtrip",
  );
  context.state.set("SECTOR_NUMBER", 3);
  context.state.set("SOURCE_SHA256", "abc123");
  context.state.set("RECOVERED_SHA256", "abc123");
  context.state.set("SEALED_SHA256", "sealed123");
  context.state.set("UNSEALED_CID", "unsealed-cid");
  context.state.set("RECOVERED_CAR", join(runDir, "recovered.car"));
  context.state.set("PROOF_BACKEND", "zigzag");
  context.state.set("PROOF_BACKEND_REASON", "FIL_PROOFS_USE_ZIGZAG=1 and StackedDrg8MiBV1_1 has a ZigZag-supported 8 MiB sector size");
  context.state.set("UNSEAL_PATH", "ZigZag filecoinffi.Unseal; SDRKeyRegen is skipped as a scheduler-compatible no-op");
  context.state.set("REGISTERED_SEAL_PROOF", 6);
  context.state.set("REGISTERED_SEAL_PROOF_NAME", "StackedDrg8MiBV1_1");
  context.state.set("REGISTERED_SEAL_PROOF_SECTOR_SIZE_BYTES", 8 * 1024 * 1024);

  await runStep(context, "verify ProveCommit on-chain without waiting for WindowPoSt", () => undefined);
  await runStep(context, "verify unsealed CommD with Curio", () => undefined);
  await runStep(context, "recover exact piece bytes from FTUnsealed", () => undefined);
  await runStep(context, "verify sealed replica and on-chain sector remain unchanged", () => undefined);
  const summaryPath = writeRunSummary(context);

  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    result: string;
    scenario: string;
    steps: string[];
    stepResults: Array<{ status: string }>;
    summaryMarkdownPath: string;
  };
  assert.equal(summary.result, "passed");
  assert.equal(summary.scenario, "seal-unseal-roundtrip");
  assert.equal(summary.steps.length, 4);
  assert.equal(summary.stepResults.length, 4);
  assert.ok(summary.stepResults.every((step) => step.status === "passed"));
  assert.equal(summary.summaryMarkdownPath, join(runDir, "summary.md"));

  const report = readFileSync(summary.summaryMarkdownPath, "utf8");
  assert.match(report, /✅ \*\*PASSED\*\*/);
  assert.match(report, /## Seal\/unseal verdict/);
  assert.match(report, /Proof backend \| ✅ ZigZag \| registered proof `StackedDrg8MiBV1_1` \(6\)<br>sector size `8 MiB`/);
  assert.match(report, /unseal path: ZigZag filecoinffi\.Unseal/);
  assert.match(report, /WindowPoSt wait \| ⏭ skipped by design/);
  assert.match(report, /Source\/recovered SHA-256 \| ✅ passed/);
  assert.match(report, /all 4 recorded steps completed successfully/);
  assert.match(report, /\.\/04-verify-sealed-replica-and-on-chain-sector-remain-unchanged\.json/);
});

test("benchmark summary renders retrieval and resource metric tables", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "scenario-runtime-"));
  const context = createScenarioContext(
    config(runDir),
    runDir,
    "run-bench-retrieval",
    "bench-retrieval",
  );
  const resourceSummaryPath = join(runDir, "retrieval-cold.resource-summary.json");
  const resourceMetricsPath = join(runDir, "retrieval-cold.resource-metrics.ndjson");
  writeFileSync(resourceSummaryPath, `${JSON.stringify({
    scope: "retrieval-cold",
    durationMs: 2_000,
    sampleCount: 4,
    metricsPath: resourceMetricsPath,
    summaryPath: resourceSummaryPath,
    totals: {
      cpuTimeMs: 1_250,
      averageCpuCores: 0.625,
      peakObservedMemoryBytes: 128 * 1024 * 1024,
      cgroupPeakMemoryBytes: 256 * 1024 * 1024,
      ioReadBytes: 4 * 1024 * 1024,
      ioWriteBytes: 2 * 1024 * 1024,
    },
    services: [{
      service: "curio",
      sampleCount: 2,
      errorCount: 0,
      cpuTimeMs: 1_000,
      averageCpuCores: 0.5,
      peakObservedMemoryBytes: 96 * 1024 * 1024,
      cgroupPeakMemoryBytes: 192 * 1024 * 1024,
      ioReadBytes: 4 * 1024 * 1024,
      ioWriteBytes: 2 * 1024 * 1024,
    }],
  })}\n`);
  context.state.set("BENCHMARK_KIND", "retrieval");
  context.state.set("RETRIEVAL_BENCH_SCOPE", "Curio HTTP /piece/{cid}");
  context.state.set("RETRIEVAL_BENCH_SOURCE_NOTE", "MK20 may use piece park");
  context.state.set("RETRIEVAL_COLD_STORAGE_BEFORE", "sealed=true,unsealed=false,target=false");
  context.state.set("RETRIEVAL_COLD_STORAGE_AFTER", "sealed=true,unsealed=false,target=false");
  context.state.set("RETRIEVAL_COLD_HTTP_STATUS", 200);
  context.state.set("RETRIEVAL_COLD_BYTES", 1_804_534);
  context.state.set("RETRIEVAL_COLD_TTFB_MS", 250);
  context.state.set("RETRIEVAL_COLD_TOTAL_MS", 2_000);
  context.state.set("RETRIEVAL_COLD_THROUGHPUT_BYTES_PER_SECOND", 902_267);
  context.state.set("RETRIEVAL_COLD_SHA256", "a".repeat(64));
  context.state.set("RETRIEVAL_COLD_SHA256_MATCH", "true");
  context.state.set("RETRIEVAL_COLD_OUTPUT", join(runDir, "retrieved-cold.car"));
  context.state.set("RETRIEVAL_COLD_RESOURCE_SUMMARY", resourceSummaryPath);

  await runStep(context, "bench cold retrieval via Curio HTTP /piece", () => undefined);
  const summaryPath = writeRunSummary(context);
  const report = readFileSync(join(runDir, "summary.md"), "utf8");

  assert.equal(summaryPath, join(runDir, "summary.json"));
  assert.match(report, /## Retrieval benchmark/);
  assert.match(report, /Source note: MK20 may use piece park/);
  assert.match(report, /cold \| sealed=true,unsealed=false,target=false \| sealed=true,unsealed=false,target=false \| ✅ HTTP 200, hash match/);
  assert.match(report, /retrieved-cold\.car/);
  assert.match(report, /## Resource metrics/);
  assert.match(report, /retrieval-cold \| 2\.00 s \| 1\.25 s \| 0\.625 \| 128\.0 MiB/);
  assert.match(report, /Service metrics: retrieval-cold/);
  assert.match(report, /curio \| 1\.00 s \| 0\.5 \| 96\.0 MiB/);
  assert.match(report, /retrieval-cold\.resource-metrics\.ndjson/);
});

test("deliver-seal-unseal-retrieval benchmark summary labels HTTP and forced sector paths", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "scenario-runtime-"));
  const context = createScenarioContext(
    config(runDir),
    runDir,
    "run-bench-deliver-retrieval",
    "bench-deliver-seal-unseal-retrieval",
  );
  context.state.set("BENCHMARK_KIND", "deliver-seal-unseal-retrieval");
  context.state.set("BENCH_ISOLATION", "fresh-devnet");
  context.state.set("DELIVER_RETRIEVAL_BENCH_SCOPE", "fresh MK20 delivery through forced retrieval paths");
  context.state.set("RETRIEVAL_BENCH_SOURCE_NOTE", "HTTP can use piece park; sector path reads FTUnsealed bytes.");
  context.state.set("RETRIEVAL_CACHE_ISOLATION", "fresh devnet per backend; Curio restart before HTTP requests");
  context.state.set("DEVNET_PROOF_BACKEND", "stacked");
  context.state.set("PROOF_PARAMETER_CACHE_STATUS", "present");
  context.state.set("PROOF_PARAMETER_CACHE_FILE_COUNT", 3);
  context.state.set("PROOF_PARAMETER_CACHE_BYTES", 1024 * 1024);
  context.state.set("ZIGZAG_SIDECAR_DIR", join(runDir, "zigzag-proof-sidecars"));
  context.state.set("ZIGZAG_SIDECAR_FILE_COUNT", 2);
  context.state.set("ZIGZAG_SIDECAR_BYTES", 4096);
  context.state.set("DEVNET_CURIO_COMMIT", "c".repeat(40));
  context.state.set("DEVNET_LOTUS_COMMIT", "d".repeat(40));
  context.state.set("DEVNET_IMAGE_PLATFORM", "linux/arm64");
  context.state.set("IMAGE_CURIO_REFERENCE", "porep-market-curio-devnet/curio:cccccccccccc");
  context.state.set("IMAGE_CURIO_ID", `sha256:${"1".repeat(64)}`);
  context.state.set("IMAGE_LOTUS_REFERENCE", "porep-market-curio-devnet/lotus:cccccccccccc");
  context.state.set("IMAGE_LOTUS_ID", `sha256:${"2".repeat(64)}`);
  context.state.set("DOCKER_SERVER_VERSION", "29.2.1");
  context.state.set("DOCKER_CPU_COUNT", 10);
  context.state.set("DOCKER_TOTAL_MEMORY_BYTES", 8 * 1024 * 1024 * 1024);
  context.state.set("PROOF_BACKEND", "sdr");
  context.state.set("PROOF_BACKEND_REASON", "FIL_PROOFS_USE_ZIGZAG=0");
  context.state.set("REGISTERED_SEAL_PROOF", 6);
  context.state.set("REGISTERED_SEAL_PROOF_NAME", "StackedDrg8MiBV1_1");
  context.state.set("REGISTERED_SEAL_PROOF_SECTOR_SIZE_BYTES", 8 * 1024 * 1024);
  context.state.set("SOURCE_SHA256", "b".repeat(64));
  context.state.set("RECOVERED_SHA256", "b".repeat(64));
  context.state.set("RECOVERED_CAR", join(runDir, "retrieved-sector-cold.car"));

  context.state.set("RETRIEVAL_HTTP_COLD_STORAGE_BEFORE", "sealed=true,unsealed=false,target=false");
  context.state.set("RETRIEVAL_HTTP_COLD_STORAGE_AFTER", "sealed=true,unsealed=false,target=false");
  context.state.set("RETRIEVAL_HTTP_COLD_HTTP_STATUS", 200);
  context.state.set("RETRIEVAL_HTTP_COLD_BYTES", 1024);
  context.state.set("RETRIEVAL_HTTP_COLD_TTFB_MS", 20);
  context.state.set("RETRIEVAL_HTTP_COLD_TOTAL_MS", 80);
  context.state.set("RETRIEVAL_HTTP_COLD_THROUGHPUT_BYTES_PER_SECOND", 12_800);
  context.state.set("RETRIEVAL_HTTP_COLD_SHA256", "b".repeat(64));
  context.state.set("RETRIEVAL_HTTP_COLD_SHA256_MATCH", "true");
  context.state.set("RETRIEVAL_HTTP_COLD_OUTPUT", join(runDir, "retrieved-http-cold.car"));

  context.state.set("RETRIEVAL_HTTP_HOT_STORAGE_BEFORE", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_HTTP_HOT_STORAGE_AFTER", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_HTTP_HOT_HTTP_STATUS", 200);
  context.state.set("RETRIEVAL_HTTP_HOT_BYTES", 1024);
  context.state.set("RETRIEVAL_HTTP_HOT_TTFB_MS", 5);
  context.state.set("RETRIEVAL_HTTP_HOT_TOTAL_MS", 30);
  context.state.set("RETRIEVAL_HTTP_HOT_THROUGHPUT_BYTES_PER_SECOND", 34_133);
  context.state.set("RETRIEVAL_HTTP_HOT_SHA256", "b".repeat(64));
  context.state.set("RETRIEVAL_HTTP_HOT_SHA256_MATCH", "true");
  context.state.set("RETRIEVAL_HTTP_HOT_OUTPUT", join(runDir, "retrieved-http-hot.car"));

  context.state.set("RETRIEVAL_SECTOR_COLD_STORAGE_BEFORE", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_SECTOR_COLD_STORAGE_AFTER", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_SECTOR_COLD_BYTES", 1024);
  context.state.set("RETRIEVAL_SECTOR_COLD_SHA256", "b".repeat(64));
  context.state.set("RETRIEVAL_SECTOR_COLD_SHA256_MATCH", "true");
  context.state.set("RETRIEVAL_SECTOR_COLD_OUTPUT", join(runDir, "retrieved-sector-cold.car"));

  context.state.set("RETRIEVAL_SECTOR_HOT_STORAGE_BEFORE", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_SECTOR_HOT_STORAGE_AFTER", "sealed=true,unsealed=true,target=true");
  context.state.set("RETRIEVAL_SECTOR_HOT_BYTES", 1024);
  context.state.set("RETRIEVAL_SECTOR_HOT_SHA256", "b".repeat(64));
  context.state.set("RETRIEVAL_SECTOR_HOT_SHA256_MATCH", "true");
  context.state.set("RETRIEVAL_SECTOR_HOT_OUTPUT", join(runDir, "retrieved-sector-hot.car"));

  await runStep(context, "bench forced sector retrieval after cold unseal", () => undefined);
  const summaryPath = writeRunSummary(context);
  const report = readFileSync(join(runDir, "summary.md"), "utf8");

  assert.equal(summaryPath, join(runDir, "summary.json"));
  assert.match(report, /## Benchmark environment/);
  assert.match(report, /Proof backend selector \| stacked/);
  assert.match(report, /Proof parameter cache \| present, 3 files, 1\.00 MiB/);
  assert.match(report, /ZigZag sidecars \| .*zigzag-proof-sidecars, 2 files, 4\.00 KiB/);
  assert.match(report, /Curio source commit \| `cccccccccccc`/);
  assert.match(report, /Docker \| version 29\.2\.1, 10 CPUs, 8\.00 GiB/);
  assert.match(report, /Cache isolation: fresh devnet per backend; Curio restart before HTTP requests/);
  assert.match(report, /Proof backend \| ✅ SDR \| registered proof `StackedDrg8MiBV1_1` \(6\)/);
  assert.match(report, /Source\/recovered SHA-256 \| ✅ passed/);
  assert.match(report, /HTTP cold \| sealed=true,unsealed=false,target=false .* ✅ HTTP 200, hash match/);
  assert.match(report, /HTTP hot \| sealed=true,unsealed=true,target=true .* ✅ HTTP 200, hash match/);
  assert.match(report, /Sector cold \| sealed=true,unsealed=true,target=true .* ✅ sector bytes, hash match/);
  assert.match(report, /Sector hot \| sealed=true,unsealed=true,target=true .* ✅ sector bytes, hash match/);
  assert.match(report, /retrieved-sector-cold\.car/);
});

function config(projectRoot: string): E2EConfig {
  const address = "0x1111111111111111111111111111111111111111";
  const key = `0x${"1".repeat(64)}`;
  return {
    cwd: projectRoot,
    projectRoot,
    envFile: "",
    rpcUrl: "http://127.0.0.1:2234/rpc/v1",
    expectedChainId: 31415926,
    expectedPorepCommit: "a".repeat(40),
    deploymentPorepCommit: "a".repeat(40),
    deploymentTargetMode: "locked",
    deploymentTargetDirty: false,
    deploymentId: "deployment-test",
    deploymentRevision: 2,
    proofBackend: "stacked",
    sectorSizeBytes: 8_388_608,
    sectorSizeSelector: "8mib",
    deploymentRecordPath: join(projectRoot, "002.json"),
    privateKeyTest: key,
    privateKeySp: key,
    identityKeys: {
      deployer: key, client: key, providerPayee: key, porepService: key,
      operator: key, allocator: key, oracle: key, unauthorized: key,
    },
    identityAddresses: {
      deployer: address, client: address, providerPayee: address, porepService: address,
      operator: address, allocator: address, oracle: address, unauthorized: address,
    },
    generation: "generation-test",
    provider: "t01004",
    porepSourceDir: projectRoot,
    runRoot: projectRoot,
    addresses: {
      poRepMarket: address, spRegistry: address, validatorFactory: address,
      dataCapEvidenceAdapter: address, filecoinPay: address, sliOracle: address,
      metaAllocator: address, usdcToken: address, notificationReceiver: address,
      failingNotificationReceiver: address, sectorStatusInspector: address,
    },
    requiredEnv: {},
    env: {},
  };
}
