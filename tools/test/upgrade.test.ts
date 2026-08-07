import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createUpgradePlan,
  validateUpgradePreflight,
} from "../src/upgrade.js";
import type { DeploymentRevision } from "../src/deployment.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("upgrade plan accepts UUPS and Validator beacon steps", () => {
  const plan = createUpgradePlan({
    revision: deployment(),
    targetSnapshotPath: "/tmp/target",
    contracts: ["PoRepMarket", "ValidatorBeacon"],
  });
  assert.deepEqual(plan.steps, [
    { contract: "PoRepMarket", kind: "uups", calldata: "0x" },
    { contract: "ValidatorBeacon", kind: "validator-beacon", calldata: "0x" },
  ]);
});

test("upgrade plan rejects unknown, duplicate, and direct contracts", () => {
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target", contracts: ["Missing"],
  }), /unknown contract/);
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target",
    contracts: ["PoRepMarket", "PoRepMarket"],
  }), /duplicate upgrade contract/);
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target", contracts: ["FilecoinPay"],
  }), /direct contract/);
});

test("upgrade preflight rejects stale implementations, missing authority, and malformed calldata", () => {
  const revision = deployment();
  const plan = createUpgradePlan({
    revision, targetSnapshotPath: "/tmp/target", contracts: ["PoRepMarket"],
  });
  assert.throws(() => validateUpgradePreflight({
    plan: { ...plan, fromRevision: 2 },
    revision,
    liveImplementations: { PoRepMarket: address("9") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /stale fromRevision/);
  assert.throws(() => validateUpgradePreflight({
    plan,
    revision,
    liveImplementations: { PoRepMarket: address("9") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /implementation mismatch/);
  assert.throws(() => validateUpgradePreflight({
    plan,
    revision,
    liveImplementations: { PoRepMarket: address("2") },
    authorizedContracts: new Set(),
  }), /missing upgrade authority/);
  assert.throws(() => validateUpgradePreflight({
    plan: { ...plan, steps: [{ ...plan.steps[0]!, calldata: "initialize()" }] },
    revision,
    liveImplementations: { PoRepMarket: address("2") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /calldata must be explicit hex/);
});

test("upgrade execution is locked, resumable, and verifies the requested transaction and code", async () => {
  const script = await readFile(
    resolve(repositoryRoot, "scripts", "devnet-upgrade.sh"),
    "utf8",
  );
  assert.match(script, /mkdir "\$\{upgrade_lock\}"/);
  assert.match(script, /upgrade finalized after interrupted publication/);
  assert.match(script, /live implementation does not match the requested target/);
  assert.match(script, /live implementation code does not match the compiled target/);
  assert.match(script, /requested target has unchanged implementation code/);
  assert.match(script, /non-empty upgrade calldata is unsupported/);
  assert.match(script, /normalize-runtime-bytecode\.mjs/);
  assert.match(script, /\.operations\[0\]\.newImplementationCodeHash/);
  assert.match(script, /script\/Upgrade\.s\.sol:Upgrade/);
  assert.doesNotMatch(script, /UpgradeValidatorBeacon/);
  assert.match(script, /DEPLOYMENT_MANIFEST/);
  assert.match(script, /UPGRADE_CONTRACT_NAMES/);
  assert.match(script, /UPGRADE_OUTPUT/);
  assert.match(script, /ValidatorBeacon.*Validator/s);
  assert.match(script, /\.contracts\.ValidatorBeacon\.implementation/);
  assert.match(script, /\.transactionType == "CALL"/);
  assert.match(script, /\.transaction\.to/);
  assert.match(script, /\.status.*0x1/);
  assert.doesNotMatch(script, /broadcast\/\$\{broadcast_script\}\/31415926/);
  assert.doesNotMatch(script, /printf -v timestamp '%\(/);
});

test("runtime normalization ignores only declared immutable bytes", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "runtime-normalization-"));
  const artifact = resolve(directory, "Contract.json");
  writeFileSync(artifact, JSON.stringify({
    deployedBytecode: {
      object: "0x112200005566",
      immutableReferences: { self: [{ start: 2, length: 2 }] },
    },
  }));
  const script = resolve(repositoryRoot, "scripts", "normalize-runtime-bytecode.mjs");

  assert.equal(
    execFileSync(process.execPath, [script, artifact], { encoding: "utf8" }).trim(),
    "0x112200005566",
  );
  assert.equal(
    execFileSync(process.execPath, [script, artifact, "0x1122aabb5566"], {
      encoding: "utf8",
    }).trim(),
    "0x112200005566",
  );
  assert.equal(
    execFileSync(process.execPath, [script, artifact, "0x9922aabb5566"], {
      encoding: "utf8",
    }).trim(),
    "0x992200005566",
  );
});

function deployment(): DeploymentRevision {
  return {
    schemaVersion: 2,
    deploymentId: "deployment-test",
    revision: 1,
    parentRevision: 0,
    generatedAt: "2026-07-26T00:00:00Z",
    chain: {
      generation: "generation-test",
      genesisCid: `baf${"a".repeat(30)}`,
      chainId: 31415926,
      epoch: 10,
      provider: "t01004",
    },
    proof: { backend: "stacked" },
    target: {
      mode: "locked", sourcePath: "/tmp/source", snapshotPath: "/tmp/old",
      commit: "a".repeat(40), dirty: false, submodules: {},
    },
    identities: { deployer: address("1") },
    contracts: {
      PoRepMarket: {
        address: address("1"), runtimeCodeHash: hash("1"), kind: "uups",
        implementation: address("2"), implementationCodeHash: hash("2"),
      },
      ValidatorBeacon: {
        address: address("3"), runtimeCodeHash: hash("3"), kind: "beacon",
        implementation: address("4"), implementationCodeHash: hash("4"),
      },
      FilecoinPay: {
        address: address("5"), runtimeCodeHash: hash("5"), kind: "direct",
      },
    },
    transactions: [],
  };
}

function address(value: string): string {
  return `0x${value.repeat(40)}`;
}

function hash(value: string): string {
  return `0x${value.repeat(64)}`;
}
