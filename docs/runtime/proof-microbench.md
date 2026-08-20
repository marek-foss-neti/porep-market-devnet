# Proof Microbenchmarks

`just bench-proof-micro` runs the proof code path without Curio scheduling,
HarmonyDB, chain message waits, or HTTP retrieval. It is meant to explain where
the backend cost comes from after the end-to-end devnet benchmark has already
proved correctness.

```bash
just build
just bench-proof-micro zigzag 8mib
just bench-proof-micro stacked 8mib
just bench-proof-micro-backends 8mib
```

The command uses the already built `curio-all-in-one` image and writes reports
under `.runtime/runs/<timestamp>-bench-proof-micro-<backend>-<sector>/`.

Stacked/SDR microbench runs enable `FIL_PROOFS_USE_MULTICORE_SDR=1` by default,
because the `porep-proof-microbench` binary is built with the `multicore-sdr`
feature and this better matches the optimized Stacked replication path. ZigZag
runs force that setting to `0`, since it is not part of the ZigZag path. To run
an explicit single-core SDR control case:

```bash
BENCH_STACKED_USE_MULTICORE_SDR=0 just bench-proof-micro stacked 8mib
```

Each generated `summary.md` records both the Stacked SDR replication mode and
the effective `FIL_PROOFS_USE_MULTICORE_SDR` value.

By default the microbench is intentionally limited to `2kib` and `8mib` sectors,
because it performs a complete local seal/prove/verify/unseal cycle and keeps
the generated user bytes for exact recovery checks. Larger registered sector
sizes can be enabled explicitly:

```bash
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro zigzag 512mib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-backends 512mib
```

Use that opt-in only on a machine with enough memory, disk, proof parameters, and
time budget. The restore-zigzag overlay in this branch supports ZigZag for
`2kib`, `8mib`, `512mib`, and `32gib`.

Each run first executes `porep-proof-microbench --prewarm-only` in a separate
container to generate or load the exact PoRep Groth parameters and backend
parent cache for the selected backend and sector size. The prewarm output is
written to `param-prewarm.json`. This keeps first-run parameter/cache generation
and its memory peak out of the measured proof phases in `summary.json`.

Stacked/SDR microbench runs use an isolated parameter cache under the run
directory, because local Groth parameter generation is not the official
Filecoin production parameter set that Lotus checksum-validates on startup.
ZigZag microbench runs continue to use `.cache/proof-parameters/`, because
these devnet-specific ZigZag parameters need to be available to the ZigZag
runtime verifier.

For raw unseal/retrieval experiments, use the fixture mode instead of the full
proof microbench:

```bash
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-prepare-fixture zigzag 32gib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-unseal zigzag 32gib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-unseal-backends 32gib
```

`prepare-fixture` creates a deterministic full-sector piece, seals it, and
writes `fixture.json`, the sealed sector, and the seal cache under
`.runtime/proof-micro-fixtures/<backend>-<sector>/`. It stops after
pre-commit phase 2 and never calls Groth parameter generation, prove, or verify.
`unseal-only` then loads that fixture and measures only the raw range recovery
phase. If the fixture is missing, the script prepares it first and still keeps
fixture preparation outside the measured unseal phase.

In this direct Rust microbench, "retrieval" means recovering an unpadded byte
range from the sealed sector without Curio scheduling, HTTP serving, piece park,
or chain state. The default range is the full unpadded sector. Use
`BENCH_UNSEAL_RANGE_OFFSET` and `BENCH_UNSEAL_RANGE_SIZE` for smaller range
tests:

```bash
BENCH_UNSEAL_RANGE_SIZE=1048576 just bench-proof-micro-unseal-backends 8mib
```

The unseal-only path intentionally skips the proof-parameter cache and does not
read or create `.meta`, `.params`, or `.vk` files. ZigZag uses
`zigzag_unseal_range` over a copy-on-write mmap of the sealed sector. Stacked
/ SDR uses Filecoin proofs' `get_unsealed_range_mapped`, which is the mapped
raw unseal helper used by the Stacked path. Both functions unseal the sealed
sector and write the requested unpadded range to a verification sink that checks
the deterministic bytes without writing another large output file.

Large fixtures and parent caches can live outside the repository by passing
host paths:

```bash
BENCH_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-prewarm-debug-32gib/parent-cache \
BENCH_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-unseal-fixture-32gib \
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
just bench-proof-micro-unseal zigzag 32gib
```

For `bench-proof-micro-unseal-backends`, prefer backend-specific paths so the
two backends cannot accidentally share a fixture or parent-cache directory:

```bash
BENCH_ZIGZAG_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-prewarm-debug-32gib/parent-cache \
BENCH_ZIGZAG_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-unseal-fixture-32gib \
BENCH_STACKED_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/stacked-prewarm-debug-32gib/parent-cache \
BENCH_STACKED_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/stacked-unseal-fixture-32gib \
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
just bench-proof-micro-unseal-backends 32gib
```

Both backends use persistent parent-cache directories under `.cache/`, mounted
as `FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents`. Stacked/SDR uses its
existing windowed parent cache. ZigZag uses the restore-zigzag parent table with
the same windowed mmap model, so the on-disk cache can be large without mapping
the whole file into RAM. `DEVNET_PARENT_CACHE_WINDOW_NODES` sets the default
window size; `BENCH_PARENT_CACHE_WINDOW_NODES` can override it for benchmark
runs.

During long prewarms the lifecycle scripts print a heartbeat every
`DEVNET_PROGRESS_INTERVAL_SECONDS` seconds with elapsed time, proof-parameter
cache size, the newest cache file, and the latest prewarm log line.

The prewarm also records the exact parameter cache identifier and validates that
the cached verifying key matches the Groth params file for that identifier. If a
stale `.vk` is found next to a freshly generated `.params`, the microbench
rewrites only that verifying key before any measured phase starts and records
`verifying_key_rewritten=true` in `param-prewarm.json`.

The measured phases are:

| Phase | ZigZag | Stacked / SDR |
| --- | --- | --- |
| `pre_commit_phase1` | `zigzag_pre_commit_phase1` | `seal_pre_commit_phase1` |
| `pre_commit_phase2` | `zigzag_pre_commit_phase2` | `seal_pre_commit_phase2` |
| `prove_from_cache` | `zigzag_prove_from_cache` | N/A |
| `prove_from_cache_equivalent_phase1/2` | N/A | `seal_commit_phase1` + `seal_commit_phase2` |
| `verify` | `zigzag_verify_seal` | `verify_seal` |
| `raw_unseal` | `zigzag_unseal_range` | `get_unsealed_range_mapped` |

The SDR proof path does not have an exact `prove_from_cache` function. Its
closest comparable scope is commit phase 1 plus commit phase 2, both operating
from persisted pre-commit cache and the sealed replica.

The report includes wall time, process CPU time, max RSS, proof length,
registered seal proof, verify result, raw byte recovery, parent-cache directory,
and parent-cache window size. Proof parameter and parent-cache generation are
separated from measured phases by `param-prewarm.json`; keep the shared
`.cache/proof-parameters` and backend parent-cache directories when comparing
repeated runs.
The canonical `just bench-proof-backends <sector>` runner uses the same
`--prewarm-only` path for both backends against the shared devnet proof
parameter cache before it starts any fresh-devnet measurement.

ZigZag proof sidecars used by the Curio/Lotus FFI integration are not part of
this direct Rust microbench. The microbench verifies with `comm_r_star` in
process, while the full devnet flow writes sidecars under
`.runtime/devnet/zigzag-proof-sidecars`.
