# Bounded ZigZag TreeR hashing on GPU

The optional TreeR backend uses Neptune 11 `Batcher<Scalar, U2>` with the same
MerkleTree domain and standard strength as the CPU's `POSEIDON_CONSTANTS_2`.
It adapts SDR's Neptune batching to ZigZag's full binary DiskStore: every leaf
and internal node retains its existing offset and encoding. It does not use
SDR's column builder, TreeC, or compact TreeRLast format. TreeD, the replica
encoding, commitments, circuit, parameter ID and verification path are unchanged.

This is implemented on the GPU branches and **disabled by default**. Remote
validation on 2026-10-22 passed CUDA builds, actual GPU/CPU TreeR equality and
four complete 2 KiB proof/unseal cycles on an NVIDIA A40. Full 512 MiB/32 GiB
memory and performance acceptance is still pending; small correctness tests
do not establish a sealing speedup. See the validation details below.
Keep all changes unstaged for manual review; do not stage or commit automatically.

## Execution and memory

One dedicated thread owns a Neptune batcher across all TreeR layers in one PC1.
It reads bounded pairs from a physically preallocated private store, converts
canonical little-endian field elements, hashes a batch, serializes it, then
writes the parents at the CPU builder's offsets. A level finishes before its
parents are read. There is one active batch and no prefetched full level.
Neptune's program/constants persist across batches and layers; its public API
still allocates input/output device buffers for each call.

The existing `stream`/`overlap` pipeline keeps one TreeR build in progress while
encoding/capturing the next layer. The snapshot pool and background writeback
credit window remain bounded. GPU mode does not create the CPU TreeR Rayon
pool; a single hashing worker also handles small upper levels on CPU. This
initial implementation does not overlap transfer with hashing or compute
multiple levels in a GPU-resident subtree.

For B pairs, explicit peak host batch storage is bounded by **224 × B bytes**:
64B raw input, 64B field pairs, 32B serialized output, and two 32B Neptune result
vectors (Neptune 11 returns a clone). Accounting adds a 16 MiB constants
allowance. Default B=262144 gives 56 MiB of batch vectors, or 72 MiB with that
allowance. The maximum B=1048576 gives 224 MiB plus the allowance. Scratch
capacity shrinks for small trees. Device input/output is 96 × B bytes, default
24 MiB, plus the constants allowance. This device estimate excludes CUDA/OpenCL
context, driver/module and allocator overhead; it is not a measured VRAM peak.
The snapshot pool, dirty file pages and active replica are separate from these
batch bounds. No memory limit is raised by enabling TreeR GPU.

Parents in levels with at most 4096 output nodes are hashed on CPU by default.
This is a conservative starting threshold, not a measured optimum. Zero forces
all internal levels onto GPU. Batch size is enforced by the adapter, independently
of Neptune's `max_batch_size` hint. Malformed fields, wrong output lengths,
device errors, writeback errors and cancellation abort the build. There is no
silent CPU retry after a GPU error. Workers are joined and the private incomplete
store is deleted; only a synced, reopened store can be published. The existing
generation mechanism publishes ready AUX only after all layers succeed.

## Configuration

| Benchmark variable | Worker variable | Default | Range |
| --- | --- | ---: | --- |
| `BENCH_ZIGZAG_TREE_R_GPU` | `FIL_PROOFS_ZIGZAG_TREE_R_GPU` | 0 | 0 or 1 |
| `BENCH_ZIGZAG_TREE_R_GPU_BATCH_SIZE` | `FIL_PROOFS_ZIGZAG_TREE_R_GPU_BATCH_SIZE` | 262144 | 1–1048576 |
| `BENCH_ZIGZAG_TREE_R_GPU_CPU_THRESHOLD` | `FIL_PROOFS_ZIGZAG_TREE_R_GPU_CPU_THRESHOLD` | 4096 | 0–1048576 |

Requires Linux, the `binary` disk builder, an explicit CUDA/OpenCL worker and one
visible device. CPU-only builds reject GPU requests. `sequential`, `overlap` and
`stream` all use this adapter. Existing CPU defaults and SDR builds are unchanged.
The workspace already enables Neptune `bls` and `arity2`; the selected backend
propagates through the dedicated FFI feature graph. No new dependency or fork is
introduced. The microbench records the resolved TreeR GPU configuration in JSON.

`versions.lock.yaml` pins this implementation to committed Rust revision
`43d6961ad1e993d629e62c2de00cb9f78a2a8440` on `restore-zigzag-gpu`.
Fetch the managed sources and rebuild the dedicated GPU images on the remote
machine. This revision includes `TreeRGpuConfig` and needs no development-source
override. For further uncommitted changes, use a compatible isolated source copy
selected with `DEVNET_RUST_FIL_PROOFS_SOURCE`. Build instructions and architecture selection remain in
[the Groth16 GPU guide](zigzag-gpu-groth16.md).

For a future comparison on the same remote machine and rebuilt CUDA image:

```sh
export BENCH_ZIGZAG_GPU_DEVICE="GPU-<selected-device-uuid>"

# GPU C2, CPU TreeR control.
BENCH_ZIGZAG_GPU_BUILD=cuda BENCH_ZIGZAG_GPU_BACKEND=cuda \
  BENCH_ZIGZAG_TREE_R_GPU=0 just bench-zigzag-512

# GPU C2 and GPU TreeR, with the same stream pipeline and other settings.
BENCH_ZIGZAG_GPU_BUILD=cuda BENCH_ZIGZAG_GPU_BACKEND=cuda \
  BENCH_ZIGZAG_TREE_R_GPU=1 just bench-zigzag-512
```

The same settings apply to `just bench-zigzag-32g`. CUDA full runs with GPU TreeR
default to `BENCH_ZIGZAG_REQUIRE_TREE_R_GPU=1`, requiring an Nsight trace. C2's
`BENCH_ZIGZAG_REQUIRE_GPU` remains a separate acceptance flag. Configuration alone
never confirms execution. OpenCL has no equivalent trace acceptance yet. The
separate parameter prewarm explicitly disables both GPU C2 and GPU TreeR.

## FFI, Curio and device admission

Both ordinary PC1 and Curio split PC1 reach the same Rust builder through the
existing FFI APIs. Curio's split PC1 executes in `TreeRCTask` (inside its FFI
precommit-phase2 call), so that task now reserves one whole GPU, one concurrent
task, the ZigZag CPU allowance and up to 60 GiB host RAM for explicit GPU TreeR.
This matches GPU C2's whole-device reservation and container RAM cap; it is
admission policy, not a measured upper bound on PC1 memory. Other configurations
retain their existing task resources.

Use `DEVNET_ZIGZAG_TREE_R_GPU=1` with the existing explicit CUDA Curio startup
configuration. Compose also accepts `DEVNET_ZIGZAG_TREE_R_GPU_BATCH_SIZE` and
`DEVNET_ZIGZAG_TREE_R_GPU_CPU_THRESHOLD`. Reapply these settings when regenerating
the Compose configuration. The launcher validates them before FFI starts.

Neptune does not share Bellperson's internal locking. The adapter holds the
existing device-specific ZigZag admission lock for its PC1 worker, preventing
concurrent C2/TreeR contexts among participating ZigZag processes. Each GPU batch
also takes Bellperson 0.27's `bellman.gpu.lock`, checking its
`bellman.priority.lock`. Priority PoSt can acquire the device between bounded
batches; disk I/O does not hold that GPU lock. Workers release persistent Neptune
state when they observe priority demand while waiting, after a batch or when idle.
The lock directory must be
the shared `TMPDIR`; per-device Bellperson lock mode is rejected. Existing FFI
subprocess environment forwarding preserves that directory. All participating
PoSt/SDR workers must use the same lock directory and compatible permissions;
Harmony and file locks cannot coordinate unrelated host GPU applications.

## Evidence and deferred acceptance

`zigzag_merkle` records survive in `report.json` and Markdown with CPU/GPU hash
counts, batch counts, read/conversion/serialization/write durations, lock wait,
initialization and Neptune API call time, payload bytes and buffer accounting.
Neptune's call combines temporary allocation, H2D, kernel and D2H. It must not be
reported as pure kernel time. Nsight records actual kernel/transfer/API intervals;
transfer and initialization totals cover TreeR and C2 together. They overlap and
are not added to phase wall times. The first initialization and subsequent reuse
remain visible per layer; priority release can cause later reinitialization.

`gpu-summary.json` separately reports `tree_r_gpu_execution_confirmed`. Acceptance
requires a complete trace and successful full CPU proof verification/unseal,
completed `hash_preimages_*_2_standard` kernels matching the total logged batch
count, and exactly one completed GPU TreeR record for every layer, with CPU+GPU
hashes equal to leaves−1. Wrong arity, missing/duplicate layers, count mismatches
and known fallbacks fail acceptance even if C2's FFT/MSM check passes. This
establishes execution evidence, not a speedup.

Rust tests cover full store/root equivalence, partial
batches, CPU upper-level thresholds, reopening/proofs, bounded writeback,
malformed input, injected GPU errors, cancellation/cleanup/retry and the priority
lock protocol. An ignored device test compares actual Neptune GPU stores to CPU
across batches and layers, including 32 MiB input with the default batch of
262144 pairs and the default CPU threshold of 4096. A Curio test covers resource
admission and isolation.

### Remote validation, 2026-10-22

The isolated source snapshot on the remote machine passed:

- 31 distinct Rust tests: 14 builder/batching tests, seven pipeline tests,
  six writeback tests, three GPU configuration tests and the explicitly enabled
  real-GPU equality test. The GPU test also passed after adding the production
  batch fixture, across two consecutive layers.
- CPU and OpenCL `cargo check` for `storage-proofs-porep`, plus CUDA release
  builds of the FFI microbench, Curio and sptool.
- The Curio resource test and its four exclusion cases, run with the real CUDA
  driver after compiling the test binary. Docker's build environment does not
  expose `libcuda.so.1`, so the test executes in a GPU runtime container.
- 54 devnet contract tests, 28 settings/report tests and 11 CUDA trace parser
  tests; TypeScript, shell syntax and formatting checks also passed.
- Four complete 2 KiB cycles using the same CPU-prewarmed parameters: CPU TreeR
  with GPU C2, then GPU TreeR with `stream`, `overlap` and `sequential`. All passed
  seal verification and byte-for-byte unseal. Both TreeR files had identical
  SHA-256 across the four cycles.

Each cycle's CUDA trace confirmed 21 FFT and eight MSM kernels. Each GPU TreeR
cycle additionally confirmed 26 U2 Poseidon kernels matching all published
layers and logged batches; the CPU TreeR control executed zero Poseidon kernels.
The small cycles deliberately used batch size 7 and CPU threshold 0 to exercise
GPU hashing even on 2 KiB sectors. Production batch bounds were checked separately
by the 32 MiB TreeR equality fixture.

The [local validation record](../../.runtime/remote-builds/zigzag-gpu-treer-20261022/validation.json)
contains source digests, test scope and matching TreeR hashes. Tests used an
isolated copy of unstaged changes and a rebuilt microbench binary; the primary
remote checkout and existing GPU image manifests were unchanged.

Still required: full 512 MiB and 32 GiB memory/performance acceptance, concurrent
real PoSt priority integration, and execution on an OpenCL device. Choose the
CPU threshold and batch size from those measurements before changing defaults.
