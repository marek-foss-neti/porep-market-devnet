import assert from "node:assert/strict";
import test from "node:test";
import { containerName } from "../src/devnet/docker.js";
import {
  describeUnsealProgress,
  parseCommp,
  parseCurioStorageRoots,
  parseSectorPieceRow,
  parseSha256,
  resolveProofBackendFromEnv,
} from "../src/devnet/curioUnseal.js";

test("resolves validated Compose container names", () => {
  assert.equal(containerName("curio"), "porep-market-curio-devnet-curio-1");
  assert.throws(() => containerName("unknown"), /unknown DevNet service/);
});

test("parses hashes and CommP emitted by the pinned container tools", () => {
  assert.equal(
    parseSha256(`${"a".repeat(64)}  /tmp/piece.car\n`),
    "a".repeat(64),
  );
  assert.deepEqual(parseCommp([
    "CommP CID: baga6ea4seaqexample",
    "Piece size: 2097152",
  ].join("\n")), {
    pieceCid: "baga6ea4seaqexample",
    pieceSize: 2_097_152,
  });
});

test("rejects malformed hash and CommP output", () => {
  assert.throws(() => parseSha256("not-a-hash"), /did not return a SHA256/);
  assert.throws(() => parseCommp("CommP CID: baga"), /failed to parse CommP/);
});

test("parses a durable Curio sector-piece mapping", () => {
  assert.deepEqual(parseSectorPieceRow(JSON.stringify({
    spId: 1004,
    sector: 42,
    regSealProof: 6,
    sectorOffset: 0,
    pieceSize: 2_097_152,
    rawSize: 1_500_123,
    pieceCid: "baga6ea4seaqexample",
  })), {
    spId: 1004,
    sector: 42,
    regSealProof: 6,
    sectorOffset: 0,
    pieceSize: 2_097_152,
    rawSize: 1_500_123,
    pieceCid: "baga6ea4seaqexample",
  });
  assert.throws(
    () => parseSectorPieceRow('{"spId":1004,"pieceCid":"baga"}'),
    /invalid sector/,
  );
});

test("parses absolute local roots from Curio storage.json", () => {
  assert.deepEqual(parseCurioStorageRoots(JSON.stringify({
    StoragePaths: [{ Path: "/var/lib/curio" }, { Path: "/mnt/sectors" }],
  })), ["/var/lib/curio", "/mnt/sectors"]);
  assert.throws(
    () => parseCurioStorageRoots('{"StoragePaths":[{"Path":"relative"}]}'),
    /non-absolute storage path/,
  );
  assert.throws(() => parseCurioStorageRoots("{}"), /no StoragePaths/);
});

test("renders verbose unseal stages", () => {
  const storage = { sealed: true, unsealed: false, targetUnsealState: true };
  assert.match(describeUnsealProgress(undefined, storage), /waiting for unseal pipeline/);
  assert.match(describeUnsealProgress({
    taskIdUnsealSdr: 10,
    afterUnsealSdr: false,
    taskIdDecodeSector: null,
    afterDecodeSector: false,
  }, storage), /SDRKeyRegen running \(task 10\)/);
  assert.match(describeUnsealProgress({
    taskIdUnsealSdr: null,
    afterUnsealSdr: true,
    taskIdDecodeSector: 11,
    afterDecodeSector: false,
  }, storage), /UnsealDecode running \(task 11\)/);
  assert.match(describeUnsealProgress({
    taskIdUnsealSdr: null,
    afterUnsealSdr: true,
    taskIdDecodeSector: 12,
    afterDecodeSector: false,
  }, storage, true, "zigzag"), /ZigZag UnsealDecode running \(task 12\)/);
});

test("resolves the proof backend used by the seal-unseal scenario", () => {
  assert.deepEqual(
    resolveProofBackendFromEnv({ FIL_PROOFS_USE_ZIGZAG: "1" }, 6),
    {
      backend: "zigzag",
      label: "ZigZag",
      registeredSealProof: 6,
      registeredSealProofName: "StackedDrg8MiBV1_1",
      sectorSizeBytes: 8 * 1024 * 1024,
      reason: "FIL_PROOFS_USE_ZIGZAG=1 and StackedDrg8MiBV1_1 has a ZigZag-supported 8 MiB sector size",
      unsealPath: "ZigZag filecoinffi.Unseal; SDRKeyRegen is skipped as a scheduler-compatible no-op",
    },
  );
  assert.equal(resolveProofBackendFromEnv({}, 6).backend, "sdr");
  assert.equal(resolveProofBackendFromEnv({ FIL_PROOFS_USE_ZIGZAG: "true" }, 8).backend, "sdr");
});
