import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeLock } from "../src/runtime-lock.js";
import { inspectRenderedCompose, parseComposeRuntimeContract } from "../src/devnet.js";

const base = `DEVNET_CURIO_IMAGE=fixture/curio-zigzag:test
DEVNET_CURIO_SHORT_COMMIT=123456789abc
DEVNET_DATA_DIR=/fixture/data
LOTUS_DEVNET_NETWORK_BUNDLE=testing
DEVNET_FIREHORSE_HEIGHT=20
DEVNET_FILECOIN_SERVICES_SOURCE=/fixture/services
DEVNET_IMAGE_NAMESPACE=fixture
DEVNET_MULTICALL3_SOURCE=/fixture/multicall
DEVNET_PARENT_CACHE_DIR=/fixture/parents
DEVNET_PROOF_BACKEND=zigzag
DEVNET_PROOF_PARAMETERS_DIR=/fixture/params
DEVNET_SECTOR_SIZE=512mib
DEVNET_ZIGZAG_SIDECAR_DIR=/fixture/sidecars
DEVNET_YUGABYTE_IMAGE=fixture/yugabyte:test
SECTOR_SIZE=536870912
CURIO_DISABLE_ACTOR_METADATA_TASKS=1
FIL_PROOFS_PARENT_CACHE=/parents
FIL_PROOFS_SDR_PARENTS_CACHE_SIZE=0
FIL_PROOFS_USE_ZIGZAG=1
FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=1
FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE=0
FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=0
FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/sidecars
`;
const gpu = `DEVNET_CURIO_GPU_BACKEND=cuda
DEVNET_CURIO_GPU_DEVICE=GPU-1234abcd
DEVNET_CURIO_GPU_MEMORY_BYTES=64424509440
DEVNET_GPU_LOCK_DIR=/fixture/locks
`;

test("GPU contract is optional for existing CPU compose, complete and validated when present", () => {
  assert.equal(parseComposeRuntimeContract(base).curioGpu, undefined);
  assert.equal(parseComposeRuntimeContract(base + gpu).curioGpu?.backend, "cuda");
  for (const invalid of [gpu.replace("cuda", "auto"), gpu.replace("GPU-1234abcd", "all"),
    gpu.replace("64424509440", "85899345920"), gpu.replace("/fixture/locks", "relative"),
    gpu.replace(/DEVNET_CURIO_GPU_DEVICE=.*\n/, "")]) {
    assert.throws(() => parseComposeRuntimeContract(base + invalid));
  }
});

test("rendered worker requires one selected GPU, RAM cap and shared writable lock directory", async () => {
  const lock = await loadRuntimeLock(resolve(fileURLToPath(new URL("../..", import.meta.url)), "versions.lock.yaml"));
  lock.runtime.services = ["curio"];
  // This fixture isolates the worker contract from unrelated network services.
  lock.runtime.ports = {} as typeof lock.runtime.ports;
  const contract = parseComposeRuntimeContract(base + gpu);
  const curio = {
    image: contract.curioImage,
    environment: {
      FIL_PROOFS_USE_ZIGZAG: "1", FIL_PROOFS_PARENT_CACHE: "/parents",
      FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE: "1", FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE: "0",
      FIL_PROOFS_SDR_PARENTS_CACHE_SIZE: "0", FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS: "0",
      FIL_PROOFS_ZIGZAG_SIDECAR_DIR: "/sidecars", CURIO_NEW_MINER_SECTOR_SIZE: "512mib",
      CURIO_DISABLE_ACTOR_METADATA_TASKS: "1", FIL_PROOFS_ZIGZAG_GPU_BACKEND: "cuda",
      TMPDIR: "/var/tmp/filecoin-gpu-locks",
    },
    healthcheck: { test: ["CMD", "true"] }, mem_limit: 64424509440, memswap_limit: 64424509440,
    volumes: [{ type: "bind", source: "/fixture/locks", target: "/var/tmp/filecoin-gpu-locks", read_only: false }],
    deploy: { resources: { reservations: { devices: [{ driver: "nvidia", device_ids: ["GPU-1234abcd"], capabilities: ["gpu"] }] } } },
  };
  const inspect = (worker: unknown) => inspectRenderedCompose(JSON.stringify({ name: lock.runtime.composeProject, services: { curio: worker } }), lock, contract);
  assert.doesNotThrow(() => inspect(curio));
  for (const change of [
    (c: typeof curio) => { c.mem_limit = 85899345920; },
    (c: typeof curio) => { c.memswap_limit = 85899345920; },
    (c: typeof curio) => { c.environment.FIL_PROOFS_ZIGZAG_GPU_BACKEND = "cpu"; },
    (c: typeof curio) => { c.deploy.resources.reservations.devices[0]!.device_ids = ["GPU-deadbeef"]; },
    (c: typeof curio) => { c.volumes = []; },
    (c: typeof curio) => { c.volumes[0]!.read_only = true; },
    (c: typeof curio) => { c.volumes[0]!.source = "/unowned"; },
  ]) {
    const invalid = structuredClone(curio);
    change(invalid);
    assert.throws(() => inspect(invalid));
  }
});
