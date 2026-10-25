# Offline Curio SDR benchmark

Build the pinned images once after updating this checkout:

```bash
just build
just bench-curio-32g
```

This runs one **32 GiB SDR sector on CPU**, using a separate `curio-bench`
executable compiled from the pinned Curio source, its normal FFI and the
`cunative debug nosupraseal` build tags. The normal Curio service binary is
unchanged. No `just up`, `just deploy`, active deployment, database, miner
actor, wallet, FIL, DataCap or market contracts are needed. A fixed test miner
ID, sector number, ticket and seed are supplied locally. The proof is verified
locally and is not submitted to a chain.

Run benchmarks on a **remote machine**. AI must not run sealing benchmarks on
the local development machine. Leave changes unstaged for manual review; do
not create commits or stage files automatically.

## Execution

The parameter step downloads/verifies only the official SDR PoRep parameters
and verification keys for the requested sector size, through Curio's parameter
fetcher. It reuses `.cache/proof-parameters`; it does not generate Groth16
parameters or download PoSt and aggregation parameters. Parameter fetching
requires network access. The measured container uses `--network none`.

The benchmark registers a private storage directory with Curio's real
`paths.Local`, `paths.Remote`, and `ffi.SealCalls`. A single-sector in-memory
index replaces the database metadata. It does not replace any proof functions.

Measured operations, in order:

1. `prepare_input`: write a deterministic, nonzero, full-sector unpadded input,
   compute its SHA-256 and CommD with FFI. No giant in-memory input buffer.
2. `sdr`: `SealCalls.GenerateSDR`, with multicore SDR enabled.
3. `tree_d`: `SealCalls.TreeD`, using Curio's Go/SHA TreeD builder and FR32.
4. `tree_rc`: `SealCalls.TreeRC`, including the replica copy/reflink, FFI PC2,
   CommD validation and Curio's three vanilla sanity checks.
5. `vanilla_c1`: `paths.Remote.GeneratePoRepVanillaProof`.
6. `groth16_c2`: `ffiselect.FFISelect.SealCommitPhase2` in a child process.
7. `verify_seal`: FFI verification of the generated proof. These three calls
   are the same sequence used by `SealCalls.PoRepSnark`, split for measurement.
8. `finalize`: `SealCalls.FinalizeSector(keepUnsealed=false)` removes sealing
   labels/TreeD; unseal cannot reuse the last sealing layer.
9. `unseal_sdr`: regenerate the key through `SealCalls.GenerateSDR(FTKey)`.
10. `unseal_decode`: `SealCalls.DecodeSDR`, using Curio's native BLST decoder.
11. `verify_unsealed`: check padded length, FR32-unpad the whole recovered sector
    and compare its SHA-256 and length with the original input.

Sealing totals include steps 2–7. Unsealing totals include steps 9–10.
Preparation, parameter fetching, finalization and recovered-data verification
are reported separately. Parent cache creation, if needed, occurs inside SDR;
record whether the shared parent cache was already populated when comparing runs.

This measures Curio's local single-sector computation, not Harmony scheduling,
resource admission, chain inclusion or multi-sector production throughput.
CPU-only Groth16 remains SDR's existing implementation; ZigZag's compact loader,
batch size and RAM optimizations do not apply. It does not promise that a 32 GiB
CPU proof will fit in 128 GiB RAM.

## Reports and resources

Each run creates `.runtime/runs/<timestamp>-bench-curio-32gib/` with JSON/Markdown
reports, exact build provenance, container exit/OOM status and logs. Telemetry
is sampled every 500 ms and includes CPU, aggregate process RSS and container
memory, including FFI child processes. Container memory includes filesystem
cache; summed RSS may count shared pages multiple times. Missing cgroup fields
remain unavailable rather than becoming zero. An interrupted phase is reported
as a lower bound, never as a successful measurement.

The launcher requires at least **704 GiB free scratch space** for 32 GiB, before
fetching parameters. Allow additional room for a cold parameter cache (roughly
44 GiB for SDR PoRep) and parent cache (roughly 56 GiB), especially when they
reside on another filesystem. This preflight is not a disk reservation.

By default there is no explicit Docker RAM/CPU cap, matching the existing SDR
microbenchmark. The container has OOM score adjustment 1000 so the host prefers
killing the benchmark under memory pressure. The ZigZag 50 GiB base budget is
not inherited. Optional controls:

| Variable | Default | Meaning |
|---|---|---|
| `BENCH_CURIO_MEMORY_BYTES` | `0` | No explicit cap; positive values cap RAM and disable additional swap allowance |
| `BENCH_CURIO_CPUS` | `0` | All available CPUs; positive integer ≥2 sets quota, Rayon and Go concurrency |
| `BENCH_CURIO_TIMEOUT_SECONDS` | `86400` | Measured run timeout, 24 hours |
| `BENCH_CURIO_FETCH_TIMEOUT_SECONDS` | `14400` | Parameter-fetch timeout, 4 hours |
| `BENCH_TELEMETRY_INTERVAL_MS` | `500` | Sampling interval, 100–60000 ms |
| `BENCH_CURIO_RETAIN_WORK` | `0` | Retain successful run's large work files when set to `1` |
| `BENCH_PROOF_PARAMETERS_DIR` | `.cache/proof-parameters` | Absolute path to official parameters |
| `BENCH_STACKED_PARENT_CACHE_DIR` | existing SDR parent-cache path | Absolute parent-cache directory |

Only a successfully verified run's private `work/` is removed automatically.
Failed runs keep artifacts. Shared caches, Docker images and BuildKit caches
are never pruned by this command. Concurrent runs have separate work directories
but still compete for host resources.

For a short integration check on a remote machine, use the same runner with
the standard 8 MiB SDR proof geometry:

```bash
BENCH_CURIO_CPUS=4 BENCH_CURIO_MEMORY_BYTES=8589934592 \
  bash scripts/bench-curio.sh 8mib
```

The public `just bench-curio-32g` recipe always selects 32 GiB.

## Implementation validation

Validated on 2026-10-25: the new executable compiled against the pinned Curio
and FFI on a remote machine. A complete offline 8 MiB run with 4 CPU quota and
8 GiB RAM passed all 11 phases, FFI seal verification, and full recovered-input
SHA-256 verification. The measured container had networking disabled. The
standard Curio service image and running services were not replaced. This
small integration run validates wiring/correctness, not 32 GiB capacity or speed.

The launcher/report tests cover successful cleanup, retained failed artifacts,
Docker exit 137 despite successful attachment, parameter-fetch failure, default
resource settings, geometry/correctness validation, and partial telemetry.
Build-surface tests and TypeScript type checking passed. Two unrelated checks
in the broader existing devnet suite remain outside this change: a stale
ZigZag prewarm assertion expects 60 GiB instead of the current 50 GiB, and a
Dockerfile comparison requires managed Curio sources absent locally.
