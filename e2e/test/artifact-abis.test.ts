import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactAbis } from "../src/contracts/abi.js";
import type { E2EConfig } from "../src/config.js";
import { createScenarioContext } from "../src/runtime.js";

test("artifactAbis loads the current runtime build artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "porep-e2e-abis-"));
  const porep = join(root, ".runtime/contracts/work/porep-market");
  const filecoinPay = join(
    root,
    ".runtime/deployments/deployment-test/work/filecoin-pay",
  );
  const harness = join(root, ".runtime/contracts");
  for (const [name, fn] of [
    ["SPRegistry.sol/SPRegistry.json", "isProviderRegistered"],
    ["PoRepMarket.sol/PoRepMarket.json", "getDeal"],
    ["ValidatorFactory.sol/ValidatorFactory.json", "getInstance"],
    ["Validator.sol/Validator.json", "getRailStatus"],
    ["DataCapEvidenceAdapter.sol/DataCapEvidenceAdapter.json", "getClaimIds"],
    ["SLIOracle.sol/SLIOracle.json", "getAttestation"],
    ["SLIScorer.sol/SLIScorer.json", "calculateScore"],
  ]) writeArtifact(porep, name!, fn!);
  writeArtifact(filecoinPay, "FilecoinPayV1.sol/FilecoinPayV1.json", "getRail");
  writeArtifact(harness, "MockUSDC.sol/MockUSDC.json", "balanceOf");

  const context = createScenarioContext(config(root, porep), join(root, "run"));
  assert.equal(Array.isArray(artifactAbis(context).poRepMarket), true);
  assert.deepEqual(
    artifactAbis(context).filecoinPay,
    [{ type: "function", name: "getRail", inputs: [], outputs: [] }],
  );
});

test("artifactAbis fails loudly when the current runtime was not built", () => {
  const root = mkdtempSync(join(tmpdir(), "porep-e2e-abis-missing-"));
  const context = createScenarioContext(
    config(root, join(root, ".runtime/contracts/work/porep-market")),
    join(root, "run"),
  );
  assert.throws(() => artifactAbis(context), /missing contract artifact .*SPRegistry\.json/);
});

function config(projectRoot: string, porepSourceDir: string): E2EConfig {
  const testKey = `0x${"1".repeat(64)}`;
  const address = "0x1111111111111111111111111111111111111111";
  return {
    cwd: join(projectRoot, "e2e"),
    projectRoot,
    envFile: "",
    rpcUrl: "http://127.0.0.1:2234/rpc/v1",
    expectedChainId: 31415926,
    expectedPorepCommit: "a".repeat(40),
    deploymentPorepCommit: "a".repeat(40),
    deploymentTargetMode: "locked",
    deploymentTargetDirty: false,
    deploymentId: "deployment-test",
    deploymentRevision: 0,
    proofBackend: "stacked",
    deploymentRecordPath: join(projectRoot, ".runtime/deployments/latest.json"),
    privateKeyTest: testKey,
    privateKeySp: testKey,
    identityKeys: {
      deployer: testKey, client: testKey, providerPayee: testKey,
      porepService: testKey, operator: testKey, allocator: testKey,
      oracle: testKey, unauthorized: testKey,
    },
    identityAddresses: {
      deployer: address, client: address, providerPayee: address,
      porepService: address, operator: address, allocator: address,
      oracle: address, unauthorized: address,
    },
    generation: "generation-test",
    provider: "t01004",
    porepSourceDir,
    runRoot: join(projectRoot, ".runtime/runs"),
    addresses: {
      poRepMarket: address, spRegistry: address, validatorFactory: address,
      dataCapEvidenceAdapter: address, filecoinPay: address, sliOracle: address,
      metaAllocator: address, usdcToken: address,
      notificationReceiver: address, failingNotificationReceiver: address,
      sectorStatusInspector: address,
    },
    requiredEnv: {},
    env: {},
  };
}

function writeArtifact(root: string, artifactPath: string, functionName: string): void {
  const path = join(root, "out", artifactPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ abi: [{ type: "function", name: functionName, inputs: [], outputs: [] }] }, null, 2)}\n`,
  );
}
