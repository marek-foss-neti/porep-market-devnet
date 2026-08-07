import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { E2EConfig } from "../src/config.js";
import {
  activeSectorFixturePath,
  ensureActiveSectorFixture,
} from "../src/fixtures/activeSector.js";
import { createScenarioContext } from "../src/runtime.js";

test("active-sector fixture reuses a live sector", async () => {
  const context = fixtureContext();
  const existing = fixture("generation-test", 7);
  writeFixture(context, existing);
  let creates = 0;
  const result = await ensureActiveSectorFixture(context, {
    isActive: async () => true,
    create: async () => {
      creates++;
      return fixture("generation-test", 8);
    },
  });
  assert.deepEqual(result, existing);
  assert.equal(creates, 0);
});

test("active-sector fixture recreates a dead sector", async () => {
  const context = fixtureContext();
  writeFixture(context, fixture("generation-test", 7));
  const result = await ensureActiveSectorFixture(context, {
    isActive: async (_context, candidate) => candidate.sector === 8,
    create: async () => fixture("generation-test", 8),
  });
  assert.equal(result.sector, 8);
});

test("active-sector fixture waits for an existing sector still activating", async () => {
  const context = fixtureContext();
  const existing = fixture("generation-test", 7);
  writeFixture(context, existing);
  let creates = 0;
  const result = await ensureActiveSectorFixture(context, {
    isActive: async () => false,
    waitUntilActive: async () => true,
    create: async () => {
      creates++;
      return fixture("generation-test", 8);
    },
  });
  assert.deepEqual(result, existing);
  assert.equal(creates, 0);
});

test("active-sector fixture prefers an already active discovered sector", async () => {
  const context = fixtureContext();
  writeFixture(context, fixture("generation-test", 7));
  let creates = 0;
  const result = await ensureActiveSectorFixture(context, {
    isActive: async () => false,
    discover: async () => fixture("generation-test", 10),
    waitUntilActive: async () => {
      throw new Error("must not wait when an active sector was discovered");
    },
    create: async () => {
      creates++;
      return fixture("generation-test", 8);
    },
  });
  assert.equal(result.sector, 10);
  assert.equal(creates, 0);
});

test("active-sector fixture rejects a record from another generation", async () => {
  const context = fixtureContext();
  writeFixture(context, fixture("old-generation", 7));
  await assert.rejects(
    ensureActiveSectorFixture(context, {
      isActive: async () => true,
      create: async () => fixture("generation-test", 8),
    }),
    /fixture generation mismatch/,
  );
});

test("concurrent fixture creation publishes one sector", async () => {
  const context = fixtureContext();
  let creates = 0;
  const dependencies = {
    isActive: async () => true,
    create: async () => {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fixture("generation-test", 9);
    },
  };
  const [left, right] = await Promise.all([
    ensureActiveSectorFixture(context, dependencies),
    ensureActiveSectorFixture(context, dependencies),
  ]);
  assert.equal(left.sector, 9);
  assert.equal(right.sector, 9);
  assert.equal(creates, 1);
});

function fixtureContext() {
  const projectRoot = mkdtempSync(join(tmpdir(), "active-sector-"));
  return createScenarioContext(config(projectRoot), join(projectRoot, "run"), "fixture-run");
}

function fixture(generation: string, sector: number) {
  return {
    generation,
    provider: "t01004",
    sector,
    deadline: 1,
    partition: 0,
    pieceCid: `baga-piece-${sector}`,
    createdByRunId: "fixture-run",
  };
}

function writeFixture(context: ReturnType<typeof fixtureContext>, value: object): void {
  const path = activeSectorFixturePath(context);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function config(projectRoot: string): E2EConfig {
  const address = "0x1111111111111111111111111111111111111111";
  const key = `0x${"1".repeat(64)}`;
  return {
    cwd: projectRoot, projectRoot, envFile: "", rpcUrl: "http://localhost",
    expectedChainId: 31415926, expectedPorepCommit: "a".repeat(40),
    deploymentPorepCommit: "a".repeat(40), deploymentTargetMode: "locked",
    deploymentTargetDirty: false,
    deploymentId: "deployment-test", deploymentRevision: 0,
    proofBackend: "stacked",
    deploymentRecordPath: join(projectRoot, "000.json"),
    privateKeyTest: key, privateKeySp: key,
    identityKeys: {
      deployer: key, client: key, providerPayee: key, porepService: key,
      operator: key, allocator: key, oracle: key, unauthorized: key,
    },
    identityAddresses: {
      deployer: address, client: address, providerPayee: address, porepService: address,
      operator: address, allocator: address, oracle: address, unauthorized: address,
    },
    generation: "generation-test", provider: "t01004", porepSourceDir: projectRoot,
    runRoot: projectRoot,
    addresses: {
      poRepMarket: address, spRegistry: address, validatorFactory: address,
      dataCapEvidenceAdapter: address, filecoinPay: address, sliOracle: address,
      metaAllocator: address, usdcToken: address, notificationReceiver: address,
      failingNotificationReceiver: address, sectorStatusInspector: address,
    },
    requiredEnv: {}, env: {},
  };
}
