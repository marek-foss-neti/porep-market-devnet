import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const address = (digit: string): string => `0x${digit.repeat(40)}`;
const key = (digit: string): string => `0x${digit.repeat(64)}`;

function fixture(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "porep-e2e-config-"));
  const deploymentId = "deployment-fixture";
  const deploymentRoot = join(projectRoot, ".runtime/deployments", deploymentId);
  mkdirSync(join(deploymentRoot, "revisions"), { recursive: true });
  mkdirSync(join(projectRoot, ".runtime/devnet/status"), { recursive: true });
  const snapshotPath = join(projectRoot, ".runtime/contracts/targets/deployment-fixture/porep-market");
  mkdirSync(snapshotPath, { recursive: true });
  writeFileSync(
    join(projectRoot, "versions.lock.yaml"),
    `sources:\n  porep_market:\n    repository: https://example.test/porep-market.git\n    commit: ${"b".repeat(40)}\n`,
  );
  writeFileSync(
    join(projectRoot, ".runtime/deployments/active.json"),
    JSON.stringify({ schemaVersion: 1, deploymentId, revision: 0 }),
  );
  writeFileSync(
    join(deploymentRoot, "revisions/000.json"),
    JSON.stringify({
      schemaVersion: 2,
      deploymentId,
      revision: 0,
      parentRevision: null,
      chain: {
        generation: "generation-a",
        genesisCid: "bafy-genesis",
        chainId: 31415926,
        epoch: 210,
        provider: "t01004",
      },
      proof: { backend: "stacked", sectorSize: { selector: "8mib", bytes: 8_388_608 } },
      target: {
        mode: "local",
        sourcePath: snapshotPath,
        snapshotPath,
        commit: "a".repeat(40),
        dirty: true,
        submodules: {},
      },
      identities: {
        deployer: address("1"), client: address("2"), providerPayee: address("3"),
        porepService: address("4"), operator: address("5"), allocator: address("6"),
        oracle: address("7"), unauthorized: address("8"),
      },
      contracts: Object.fromEntries([
        ["PoRepMarket", "1"], ["SPRegistry", "2"], ["ValidatorFactory", "3"],
        ["DataCapEvidenceAdapter", "4"], ["FilecoinPay", "5"], ["SLIOracle", "6"],
        ["MetaAllocator", "7"], ["MockUSDC", "8"],
        ["NotificationReceiver", "9"], ["FailingNotificationReceiver", "a"],
        ["SectorStatusInspector", "b"],
      ].map(([name, digit]) => [name, { address: address(digit!) }])),
    }),
  );
  writeFileSync(
    join(deploymentRoot, "identities.private.json"),
    JSON.stringify({
      deployer: key("1"), client: key("2"), providerPayee: key("3"),
      porepService: key("4"), operator: key("5"), allocator: key("6"),
      oracle: key("7"), unauthorized: key("8"),
    }),
  );
  writeFileSync(
    join(projectRoot, ".runtime/devnet/status/latest.json"),
    JSON.stringify({
      generation: "generation-a",
      chain: { chainId: "0x1df5e76" },
      miner: { provider: "t01004" },
      proof: { backend: "stacked" },
      sector: { selector: "8mib", bytes: 8_388_608 },
    }),
  );
  return projectRoot;
}

test("loadConfig reads current deployment, status, and test identities", () => {
  const projectRoot = fixture();
  const config = loadConfig({ projectRoot, env: {} });

  assert.equal(config.rpcUrl, "http://127.0.0.1:2234/rpc/v1");
  assert.equal(config.expectedChainId, 31415926);
  assert.equal(config.generation, "generation-a");
  assert.equal(config.deploymentId, "deployment-fixture");
  assert.equal(config.deploymentRevision, 0);
  assert.equal(config.proofBackend, "stacked");
  assert.equal(config.sectorSizeSelector, "8mib");
  assert.equal(config.sectorSizeBytes, 8_388_608);
  assert.equal(config.provider, "t01004");
  assert.equal(config.expectedPorepCommit, "b".repeat(40));
  assert.equal(config.deploymentPorepCommit, "a".repeat(40));
  assert.equal(config.deploymentTargetMode, "local");
  assert.equal(config.deploymentTargetDirty, true);
  assert.equal(config.addresses.poRepMarket, address("1"));
  assert.equal(config.addresses.usdcToken, address("8"));
  assert.equal(config.addresses.notificationReceiver, address("9"));
  assert.equal(config.privateKeyTest, key("2"));
  assert.equal(config.privateKeySp, key("8"));
  assert.equal(config.identityKeys.operator, key("5"));
  assert.equal(config.identityAddresses.providerPayee, address("3"));
  assert.equal(
    config.porepSourceDir,
    join(projectRoot, ".runtime/contracts/targets/deployment-fixture/porep-market"),
  );
  assert.equal(config.runRoot, join(projectRoot, ".runtime/runs"));
});

test("loadConfig rejects a stale deployment generation", () => {
  const projectRoot = fixture();
  const statusPath = join(projectRoot, ".runtime/devnet/status/latest.json");
  writeFileSync(statusPath, JSON.stringify({
    generation: "generation-b",
    chain: { chainId: "0x1df5e76" },
    miner: { provider: "t01004" },
    proof: { backend: "stacked" },
    sector: { selector: "8mib", bytes: 8_388_608 },
  }));

  assert.throws(() => loadConfig({ projectRoot, env: {} }), /deployment generation is stale/);
});

test("loadConfig reports missing runtime files without printing key material", () => {
  const projectRoot = fixture();
  const privatePath = join(
    projectRoot,
    ".runtime/deployments/deployment-fixture/identities.private.json",
  );
  writeFileSync(privatePath, JSON.stringify({ client: "not-a-key" }));

  assert.throws(
    () => loadConfig({ projectRoot, env: {} }),
    (error) => error instanceof Error &&
      /missing private identity: deployer/.test(error.message) &&
      !error.message.includes("not-a-key"),
  );
});

test("loadConfig can pin an explicit historical deployment revision", () => {
  const projectRoot = fixture();
  const config = loadConfig({
    projectRoot,
    env: {
      E2E_DEPLOYMENT_ID: "deployment-fixture",
      E2E_DEPLOYMENT_REVISION: "0",
    },
  });
  assert.equal(config.deploymentId, "deployment-fixture");
  assert.equal(config.deploymentRevision, 0);
});
