# PoRep Market DevNet ZigZag Benchmarks

Use the `test-zigzag` branch to test and benchmark the local PoRep Market
DevNet with either the Stacked DRG or ZigZag proof backend.

```sh
git fetch origin test-zigzag
git switch test-zigzag
git pull --ff-only
```

This branch is self-contained for ZigZag testing. `just bootstrap` fetches the
pinned managed sources from `versions.lock.yaml`, including
`marek-foss-neti/rust-fil-proofs` at the `restore-zigzag` commit. A separate
`../rust-fil-proofs` checkout is not required for normal testing.

## Canonical Run

```sh
just bootstrap
just build
just bench-proof-backends
```

`just bench-proof-backends` runs isolated fresh-devnet benchmarks for both
backends. It first prewarms the exact PoRep Groth parameters for each selected
backend and sector size outside measured windows. By default it then runs ZigZag
first, performs a ZigZag correctness prewarm on a fresh devnet, resets and
deploys a measured fresh ZigZag devnet, runs the deliver/seal/unseal/retrieval
benchmark, then repeats the measured flow for Stacked.

The default sector size is `8mib`. To run the same canonical comparison on a
larger registered sector size, pass the selector explicitly:

```sh
just bench-proof-backends 512mib
just bench-proof-backends 32gib
```

The comparison report is written to:

```text
.runtime/runs/<timestamp>-bench-proof-backends/summary.md
.runtime/runs/<timestamp>-bench-proof-backends/summary.json
```

## Manual Backend Runs

Use manual runs when you want to inspect one backend before running the full
comparison.

```sh
just reset zigzag 8mib
just deploy
just test-deliver-seal-unseal-retrieval active
just bench-deliver-seal-unseal-retrieval active
```

```sh
just reset stacked 8mib
just deploy
just test-deliver-seal-unseal-retrieval active
just bench-deliver-seal-unseal-retrieval active
```

`just reset <backend> <sector-size>` is the backend and sector-size switch. It
creates a fresh local chain, Curio database, sectors, and piece park for that
identity while preserving the proof parameter cache under
`.cache/proof-parameters/`.

## Proof Microbenchmarks

Use the microbench when the end-to-end benchmark says which backend is slower
and you want to see the lower-level proof phase responsible for it.

```sh
just bench-proof-micro zigzag 8mib
just bench-proof-micro stacked 8mib
just bench-proof-micro-backends 8mib
```

These runs do not start Curio or Lotus. They execute pre-commit, prove,
verify, and raw unseal inside the built `curio-all-in-one` image and write
reports under:

```text
.runtime/runs/<timestamp>-bench-proof-micro-<backend>-<sector>/summary.md
```

The default microbench is safe for `2kib` and `8mib`. Larger Stacked/SDR sector
experiments require an explicit opt-in:

```sh
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro zigzag 512mib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-backends 512mib
```

ZigZag in this branch is wired for `2kib`, `8mib`, `512mib`, and `32gib`.
`32gib` is the larger production-size target; use it only with enough Docker
memory, disk, proof parameters, and time budget.

For raw unseal/retrieval comparison without Groth parameter generation, use the
fixture mode:

```sh
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-prepare-fixture zigzag 32gib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-unseal zigzag 32gib
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-unseal-backends 32gib
```

This creates or reuses `.runtime/proof-micro-fixtures/<backend>-<sector>/` and
measures only raw range recovery from the sealed sector. It skips
`.meta/.params/.vk` entirely. For large remote runs, keep big cache/fixture data
outside the repo:

```sh
BENCH_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-prewarm-debug-32gib/parent-cache \
BENCH_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-unseal-fixture-32gib \
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
just bench-proof-micro-unseal zigzag 32gib
```

For one command that compares both backends, use backend-specific host paths:

```sh
BENCH_ZIGZAG_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-prewarm-debug-32gib/parent-cache \
BENCH_ZIGZAG_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/zigzag-unseal-fixture-32gib \
BENCH_STACKED_PARENT_CACHE_DIR=/mnt/ironwolf1/marek/filecoin/stacked-prewarm-debug-32gib/parent-cache \
BENCH_STACKED_MICRO_FIXTURE_DIR=/mnt/ironwolf1/marek/filecoin/stacked-unseal-fixture-32gib \
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
just bench-proof-micro-unseal-backends 32gib
```

The first full devnet run for `512mib` or `32gib` can also make Lotus fetch
large production proof parameters before Curio creates its market config. The
lifecycle wait is longer for these selectors and prints proof-cache heartbeats;
override it with `DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS` only when you know
the local cache is already warm or the network is unusually slow.

Before each measured microbench run, the script prewarms the exact PoRep Groth
parameters and the backend parent cache for the selected sector size in a
separate container. The first large-sector run may therefore spend significant
time creating missing `.params`, `.vk`, and parent-cache files, recorded in
`param-prewarm.json`; that prewarm time is kept out of the measured proof
phases. Stacked microbench parameter generation is isolated under the run
directory so it cannot overwrite production Filecoin proof parameters used by
Lotus. ZigZag prewarm still uses `.cache/proof-parameters/` because those
parameters are devnet-specific and must be visible to the ZigZag verifier.
Both backends use persistent parent-cache directories under `.cache/`, mounted
as `FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents`.
The canonical `just bench-proof-backends <sector>` runner is stricter: it
prewarms both backends into the shared devnet proof-parameter cache before the
fresh measured devnet resets, so Curio and Lotus use the warmed files during
the full seal/unseal/retrieval comparison.

The prewarm records the exact parameter cache id and verifies that the cached
`.vk` matches the Groth params for that id, rewriting only a stale `.vk` when
necessary before measurements begin. While prewarm is running, the terminal
prints a heartbeat with elapsed time, proof-parameter cache size, the newest
cache file, and the latest prewarm log line. Tune it with
`DEVNET_PROGRESS_INTERVAL_SECONDS`, for example:

```sh
DEVNET_PROGRESS_INTERVAL_SECONDS=5 POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 just bench-proof-micro-backends 512mib
```

## Reading Results

Each scenario run writes:

```text
.runtime/runs/<timestamp>-<scenario>/summary.md
.runtime/runs/<timestamp>-<scenario>/summary.json
```

Start with `summary.md`. It records the selected proof backend, the registered
seal proof, correctness checks, phase timings, resource metrics, retrieval
checks, SHA-256 byte comparisons, and links to raw diagnostics.

For benchmark comparison, start with:

```text
.runtime/runs/<timestamp>-bench-proof-backends/summary.md
```

That report links every backend run and shows the result, duration, proof path,
proof parameter cache state, Curio/Lotus image identity, Docker CPU/RAM, sector,
and per-run `summary.md`.

Use `summary.json` when you want machine-readable data for charts or repeated
analysis.

Useful knobs:

```sh
BENCH_BACKEND_ORDER=zigzag,stacked just bench-proof-backends
BENCH_BACKEND_ORDER=stacked,zigzag just bench-proof-backends
BENCH_REPETITIONS=3 just bench-proof-backends
BENCH_REPETITIONS=3 just bench-proof-backends 512mib
BENCH_RESOURCE_SAMPLE_INTERVAL_MS=250 just bench-proof-backends
DEVNET_PROGRESS_INTERVAL_SECONDS=10 just bench-proof-backends
DEVNET_PROGRESS=0 just bench-proof-backends
```

The comparison runner treats proof parameters and ZigZag proof sidecars
separately. Static ZigZag Groth16 `*.params` and `*.vk` files are prewarmed
outside measured windows and recorded in
`.cache/proof-parameters/.zigzag-devnet-prewarm.json`. Per-sector ZigZag proof
sidecars are runtime artifacts under `.runtime/devnet/zigzag-proof-sidecars` and
are cleared by every fresh reset.

The runnable devnet sector selector is `2kib|8mib|512mib|32gib`, defaulting to
`8mib`. It must be chosen before genesis/pre-seal, so changing it requires a
fresh reset. `1gib`, `2gib`, `4gib`, and `8gib` are not registered Filecoin
seal proof sizes in this dependency set.

Lifecycle progress messages are printed outside measured benchmark windows, so
they make reset/deploy/readiness waits visible without changing the recorded
phase resource metrics.

All devnet execution is local Docker Compose. The benchmark does not use a
public Filecoin devnet.
