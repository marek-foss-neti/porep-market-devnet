import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurioStatus,
  buildMk20DealArgs,
  curioMarketCompletionRequired,
  curioSectorReady,
  filecoinAddressFromEvmStat,
  notificationPayloadHex,
  parseAllocationId,
} from "../src/devnet/curio.js";

test("filecoinAddressFromEvmStat parses Lotus EVM output", () => {
  assert.equal(
    filecoinAddressFromEvmStat("Filecoin address:  t410fexample\nEth address: 0x1234\n"),
    "t410fexample",
  );
});

test("assertCurioStatus accepts the required live harness state", () => {
  assert.doesNotThrow(() => assertCurioStatus({
    generation: "generation-a",
    chain: { networkVersion: 28, actorsVersion: 18 },
    miner: { provider: "t01004", sectorSize: 8_388_608 },
    curio: { apiReady: true, marketReady: true, databaseReady: true, taskCount: 2 },
  }, "generation-a", "t01004"));
});

test("assertCurioStatus rejects stale or incomplete provider state", () => {
  const base = {
    generation: "generation-a",
    chain: { networkVersion: 28, actorsVersion: 18 },
    miner: { provider: "t01004", sectorSize: 8_388_608 },
    curio: { apiReady: true, marketReady: true, databaseReady: true, taskCount: 2 },
  };
  assert.throws(
    () => assertCurioStatus({ ...base, generation: "generation-b" }, "generation-a", "t01004"),
    /generation is stale/,
  );
  assert.throws(
    () => assertCurioStatus({ ...base, curio: { ...base.curio, marketReady: false } }, "generation-a", "t01004"),
    /Curio Market is not ready/,
  );
});

test("Curio notification request uses the signed stock client path and exact fields", () => {
  assert.equal(notificationPayloadHex(42n), "01000000000000002a");
  assert.deepEqual(buildMk20DealArgs({
    provider: "t01004",
    pieceCidV2: "bafkzcibexample",
    allocationId: 42n,
    notificationAddress: "t410freceiver",
    notificationPayload: "01000000000000002a",
  }), [
    "sptool", "--actor", "t01004", "toolbox", "mk20-client", "deal",
    "--provider", "t01004",
    "--http-url", "http://piece-server:12320/pieces?id=bafkzcibexample",
    "--pcidv2", "bafkzcibexample",
    "--allocation", "42",
    "--notification-address", "t410freceiver",
    "--notification-payload", "01000000000000002a",
  ]);
});

test("Curio request can identify an allowlisted contract allocation owner", () => {
  assert.deepEqual(buildMk20DealArgs({
    provider: "t01004",
    pieceCidV2: "bafkzcibexample",
    allocationId: 42n,
    notificationAddress: "t410freceiver",
    notificationPayload: "01000000000000002a",
    marketAddress: "0x1234",
  }).slice(-2), [
    "--market-address", "0x1234",
  ]);
});

test("parseAllocationId selects the newest matching allocation", () => {
  assert.equal(parseAllocationId(JSON.stringify({
    allocations: {
      "2": { Data: { "/": "baga-piece" } },
      "7": { Data: { "/": "baga-other" } },
      "9": { Data: { "/": "baga-piece" } },
    },
  }), "baga-piece"), 9n);
});

test("Curio sector readiness keeps market completion by default but permits large-sector testing actor bookkeeping gaps", () => {
  const sealedButIncomplete = {
    id: "deal-a",
    sector: 7,
    sealed: true,
    complete: false,
    allocationId: 2,
    pieceCid: "baga-piece",
  };
  assert.equal(curioSectorReady(sealedButIncomplete), false);
  assert.equal(curioSectorReady(sealedButIncomplete, { requireMarketComplete: false }), true);
  assert.equal(curioMarketCompletionRequired("8mib"), true);
  assert.equal(curioMarketCompletionRequired("512mib"), false);
  assert.equal(curioMarketCompletionRequired("32gib"), false);
});
