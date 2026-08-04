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
  assert.match(report, /WindowPoSt wait \| ⏭ skipped by design/);
  assert.match(report, /Source\/recovered SHA-256 \| ✅ passed/);
  assert.match(report, /all 4 recorded steps completed successfully/);
  assert.match(report, /\.\/04-verify-sealed-replica-and-on-chain-sector-remain-unchanged\.json/);
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
