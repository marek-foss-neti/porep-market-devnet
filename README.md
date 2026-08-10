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
backends. By default it runs ZigZag first, prewarms missing ZigZag proof
parameters outside measured windows, resets and deploys a fresh ZigZag devnet,
runs the deliver/seal/unseal/retrieval benchmark, then repeats the same flow for
Stacked.

The comparison report is written to:

```text
.runtime/runs/<timestamp>-bench-proof-backends/summary.md
.runtime/runs/<timestamp>-bench-proof-backends/summary.json
```

## Manual Backend Runs

Use manual runs when you want to inspect one backend before running the full
comparison.

```sh
just reset zigzag
just deploy
just test-deliver-seal-unseal-retrieval active
just bench-deliver-seal-unseal-retrieval active
```

```sh
just reset stacked
just deploy
just test-deliver-seal-unseal-retrieval active
just bench-deliver-seal-unseal-retrieval active
```

`just reset <backend>` is the backend switch. It creates a fresh local chain,
Curio database, sectors, and piece park for that backend while preserving the
proof parameter cache under `.cache/proof-parameters/`.

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
BENCH_RESOURCE_SAMPLE_INTERVAL_MS=250 just bench-proof-backends
DEVNET_PROGRESS_INTERVAL_SECONDS=10 just bench-proof-backends
DEVNET_PROGRESS=0 just bench-proof-backends
```

Lifecycle progress messages are printed outside measured benchmark windows, so
they make reset/deploy/readiness waits visible without changing the recorded
phase resource metrics.

All devnet execution is local Docker Compose. The benchmark does not use a
public Filecoin devnet.
