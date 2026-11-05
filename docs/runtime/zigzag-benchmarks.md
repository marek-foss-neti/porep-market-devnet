# Shared ZigZag benchmark commands

Use 512 MiB for comparative development measurements and 32 GiB to check
behavior at production size. Run these benchmarks only on the remote machine.
For lightweight local development, use the separate 8 MiB profile below.

```sh
just bench-zigzag-512
just bench-zigzag-32g
```

Each command performs one complete prewarm and seal/prove/verify/unseal run.
Both use [bench-zigzag.sh](../../scripts/bench-zigzag.sh), the same dedicated
ZigZag image and the same [comparison preset](zigzag-512-baseline.md).
Changing a default in that runner applies to both commands. Existing `BENCH_*`
overrides work for both; use identical overrides when comparing improvements.
The 17-layer preset and larger Rust cache budget require the updated Rust
dependency pin and an image rebuild; changing shell defaults alone is insufficient.

| Property | `bench-zigzag-512` | `bench-zigzag-32g` |
| --- | --- | --- |
| Padded sector | 512 MiB | 32 GiB |
| Graph nodes | 2^24 | 2^30 |
| Binary Merkle depth | 24 | 30 |
| Layers / partitions | 17 / 10 | 17 / 10 |
| Minimum challenges | 176 | 176 |
| Challenges per layer per partition | 18 | 18 |
| Total challenge instances / proof bytes | 3,060 / 1,920 | 3,060 / 1,920 |
| Default parameter directory | `.cache/zigzag-512-parameters` | `.cache/zigzag-32g-parameters` |
| Parameter-directory override | `BENCH_ZIGZAG_512_PARAMETER_DIR` | `BENCH_ZIGZAG_32G_PARAMETER_DIR` |

512 MiB uses the existing benchmark-only `zigzag-512` proof profile. The 32 GiB
command uses native 32 GiB geometry with a process-local 17-layer override. It does not pass an invented `--profile` to the binary. Its native
`benchmark.profile` remains null; sector and proof-budget fields remain explicit
in `report.json`, and the wrapper aggregate is named `zigzag-32g`. Both wrappers
validate the reported geometry, prewarm agreement,
proof length, verification and recovered byte count.

The 32 GiB command accepts `2`, `11`, `15`, `17`, `19`, `22`, or `25` layers
(default: `17`), e.g. `BENCH_PROOF_MICRO_LAYERS=11 just bench-zigzag-32g`.
The benchmark-only 512 MiB profile has a fixed 17 layers. Registered sector
configurations, including SDR, are unchanged.

Both commands default to parent buffer 32768, parent and TreeR DONTNEED enabled,
`MALLOC_ARENA_MAX=4`, compact loader, Groth16 batch 1, and 100 GiB base RAM.
They enable encode prehash, the binary TreeR builder, the stream layer pipeline,
automatic TreeR threads and 64 MiB snapshot buffers. Query cache defaults to
21474836480 bytes (20 GiB), added above the base: the measured container gets
120 GiB and prewarm gets 100 GiB. For example, these explicit overrides reduce
the measured container to 104 GiB while retaining 100 GiB for prewarm:

```sh
BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296 just bench-zigzag-512
BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296 just bench-zigzag-32g
```

Use identical overrides on both commands for comparisons. To select the older
CPU path, set both `BENCH_ZIGZAG_TREE_R_BUILDER=legacy` and
`BENCH_ZIGZAG_LAYER_PIPELINE=sequential`; prehash and query cache can be disabled
independently with their `BENCH_*` settings set to `0`. The current loader permits
base plus active query cache up to 120 GiB; see [memory policy](zigzag-query-cache.md).
Pool sizes set to `auto` resolve against the actual container CPU availability.

Groth16 parameter generation now defaults to [automatic prewarm](zigzag-auto-prewarm.md)
for both commands, with H/query worker counts selected from CPU availability and
memory headroom. `BENCH_ZIGZAG_SETUP_WORKERS=16` restores the explicit count;
the generator admission budget stays 40 GiB; the preset prewarm container gets 100 GiB.
Unlike adding the shared command, this Rust change requires fetching the updated
pinned source and rebuilding the image. Rust tests and
fresh-parameter acceptance are deferred until the active remote benchmark ends.

Parameter files depend on sector geometry and layer count. The former 11-layer
SRS cannot serve 17 layers; parent tables can be reused across layer counts. Prewarm validates/reuses the proper
files or generates missing ones; the 512 MiB and 32 GiB SRS are not interchangeable.
To reuse prepared 32 GiB caches instead of starting with the new default directory:

```sh
BENCH_ZIGZAG_32G_PARAMETER_DIR=/path/to/prepared-32g-parameters \
BENCH_ZIGZAG_PARENT_CACHE_DIR=/path/to/prepared-32g-parents \
just bench-zigzag-32g
```

The parent-cache override is supported by both commands. Without it, each uses
a directory under its own baseline run, preserving the existing 512 MiB policy.
Keep cache preparation and host load comparable; neither command forces cold OS
page cache. Work artifacts are retained for manual review and cleanup.

Per-run JSON/Markdown reports keep their existing format and location under
`.runtime/runs/`. Aggregate directories end in `zigzag-512-baseline` or
`zigzag-32g-baseline`; `baseline.json` includes the actual CPU configuration,
memory budget, sector size and proof budget alongside the image identity.

The larger sector contains 64 times as much data, with deeper Merkle paths and
different Groth16 parameters. Matching settings make optimization comparisons
more useful, but a 512 MiB speedup does not predict the same speedup at 32 GiB.
The larger run is needed to assess page-cache pressure, random reads, disk
writeback and the memory limit. This command is still a standalone benchmark;
it does not validate Curio scheduling or concurrent production workloads.

## 8 MiB development profile

```sh
just bench-zigzag-8
```

This runs the same full prewarm / PC1 / PC2 / vanilla C1 / Groth16 C2 / verify /
raw unseal workflow in the dedicated ZigZag image. It keeps 17 layers and the
optimization settings of the larger commands, including prehash, binary TreeR,
stream snapshots, automatic TreeR/prewarm workers, compact parameters and
Groth16 batch size 1. Two partitions exercise multiple C2 batches.

| Property | Development value |
| --- | --- |
| Padded sector / nodes / binary Merkle depth | 8 MiB / 2^18 / 18 |
| Layers / partitions | 17 / 2 |
| Minimum challenges / challenges per layer per partition | 4 / 2 |
| Total challenge instances / proof bytes | 68 / 384 |
| Prewarm RAM limit / setup allocation budget | 12 GiB / 10 GiB |
| Full-run RAM limit | 13 GiB: 12 GiB base + 1 GiB query cache |
| Parameter directory | `.cache/zigzag-8-parameters` |
| Parameter-directory override | `BENCH_ZIGZAG_8_PARAMETER_DIR` |

The profile is fixed and benchmark-only (`zigzag-bench` feature). Registered
proof configurations, SDR, and the 512 MiB / 32 GiB presets are unchanged.
This small challenge budget tests correctness and development changes; it is
not a production security configuration or a reliable predictor of 32 GiB speed.
Full proofs must verify, and the entire unsealed payload must match the input.
The runner rejects reports with a different proof budget or geometry.

The devnet lock pins the Rust revision that provides `zigzag_bench::config_8mib`.
Rebuild with `just build`, which fetches the pinned sources first. An old image
does not support `--profile zigzag-8`. On an ARM Mac,
use the native Linux ARM64 image. Give Docker's VM headroom above the 13 GiB
container limit (for example 16 GiB); actual peak RAM and runtime still need
measurement. These limits are initial budgets, not measured requirements.

Parameters are reused automatically on subsequent runs. Parent tables may be
reused via `BENCH_ZIGZAG_PARENT_CACHE_DIR` from a previous matching 8 MiB run;
32 GiB / 512 MiB tables and Groth16 parameters are not interchangeable with this
profile. Reports remain JSON and Markdown under `.runtime/runs/`, with aggregate
directories ending in `zigzag-8-baseline`. The standard `BENCH_*` optimization
overrides still apply. Raw unseal retains the current default parent reader;
select `BENCH_ZIGZAG_DECODE_PARENT_READER=buffered` explicitly to test the new reader.
