import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextProposalManifest } from "../src/flows/deal.js";
import { StateStore } from "../src/state.js";
import type { ScenarioContext } from "../src/runtime.js";

test("nextProposalManifest creates unique defaults within one scenario run", () => {
  const context = testContext();

  const first = nextProposalManifest(context);
  const second = nextProposalManifest(context);

  assert.notEqual(first.location, second.location);
  assert.notEqual(first.hash, second.hash);
  assert.match(first.location, /\/run-test\//);
  assert.match(first.location, /\/proposal-1\/manifest\.json$/);
  assert.match(second.location, /\/proposal-2\/manifest\.json$/);
});

test("matrix child directories do not reuse proposal manifests across runs", () => {
  const first = testContext();
  const second = testContext();
  second.runId = "run-test-2";
  second.runDir = first.runDir;
  assert.notEqual(
    nextProposalManifest(first).hash,
    nextProposalManifest(second).hash,
  );
});

test("nextProposalManifest preserves explicit manifest env values", () => {
  const context = testContext({
    V2_MANIFEST_LOCATION: "https://example.com/custom-manifest.json",
    V2_MANIFEST_HASH: "0x1234000000000000000000000000000000000000000000000000000000000000"
  });

  const first = nextProposalManifest(context);
  const second = nextProposalManifest(context);

  assert.equal(first.location, "https://example.com/custom-manifest.json");
  assert.equal(second.location, "https://example.com/custom-manifest.json");
  assert.equal(first.hash, "0x1234000000000000000000000000000000000000000000000000000000000000");
  assert.equal(second.hash, "0x1234000000000000000000000000000000000000000000000000000000000000");
});

function testContext(env: Record<string, string | undefined> = {}): ScenarioContext {
  const dir = mkdtempSync(join(tmpdir(), "porep-e2e-deal-"));
  const startedAtMs = Date.now();
  return {
    scenario: "test",
    runId: "run-test",
    config: {
      cwd: dir,
      projectRoot: dir,
      envFile: join(dir, ".env"),
      rpcUrl: "http://127.0.0.1:1234/rpc/v1",
      expectedChainId: 31415926,
      expectedPorepCommit: "a".repeat(40),
      deploymentPorepCommit: "a".repeat(40),
      deploymentTargetMode: "locked",
      deploymentTargetDirty: false,
      deploymentId: "deployment-test",
      deploymentRevision: 0,
      proofBackend: "stacked",
      sectorSizeBytes: 8_388_608,
      sectorSizeSelector: "8mib",
      deploymentRecordPath: join(dir, "latest.json"),
      privateKeyTest: "0x1",
      privateKeySp: "0x2",
      identityKeys: {
        deployer: "0x1", client: "0x2", providerPayee: "0x3", porepService: "0x4",
        operator: "0x5", allocator: "0x6", oracle: "0x7", unauthorized: "0x8",
      },
      identityAddresses: {
        deployer: "0x1", client: "0x2", providerPayee: "0x3", porepService: "0x4",
        operator: "0x5", allocator: "0x6", oracle: "0x7", unauthorized: "0x8",
      },
      generation: "generation-test",
      provider: "t01004",
      porepSourceDir: dir,
      runRoot: join(dir, ".runs"),
      addresses: {
        poRepMarket: "0x0000000000000000000000000000000000000001",
        spRegistry: "0x0000000000000000000000000000000000000002",
        validatorFactory: "0x0000000000000000000000000000000000000003",
        dataCapEvidenceAdapter: "0x0000000000000000000000000000000000000004",
        filecoinPay: "0x0000000000000000000000000000000000000005",
        sliOracle: "0x0000000000000000000000000000000000000006",
        metaAllocator: "0x0000000000000000000000000000000000000007",
        usdcToken: "0x0000000000000000000000000000000000000008",
        notificationReceiver: "0x0000000000000000000000000000000000000009",
        failingNotificationReceiver: "0x000000000000000000000000000000000000000a",
        sectorStatusInspector: "0x000000000000000000000000000000000000000b"
      },
      requiredEnv: {},
      env
    },
    runDir: join(dir, "run-one"),
    stateFile: join(dir, "state.json"),
    projectRoot: dir,
    scriptsRoot: dir,
    state: new StateStore(join(dir, "state.json")),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    steps: [],
    stepResults: [],
  };
}
