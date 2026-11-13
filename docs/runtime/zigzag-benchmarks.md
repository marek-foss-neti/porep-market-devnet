# Shared ZigZag benchmark commands

Use 512 MiB for comparative development measurements and 32 GiB to check
behavior at production size. Run these benchmarks only on the remote machine.
The 8 MiB profile below uses a smaller sector with the same proof budget.

```sh
just bench-zigzag-512
just bench-zigzag-32g
```

Each command performs one complete prewarm and seal/prove/verify/unseal run.
Both use [bench-zigzag.sh](../../scripts/bench-zigzag.sh), the same dedicated
ZigZag image and the same [comparison preset](zigzag-512-baseline.md).
Changing a default in that runner applies to both commands. Existing `BENCH_*`
overrides work for both; use identical overrides when comparing improvements.
The 750-challenge / 63-partition preset requires the updated Rust
dependency pin and an image rebuild; changing shell defaults alone is insufficient.

| Property | `bench-zigzag-512` | `bench-zigzag-32g` |
| --- | --- | --- |
| Padded sector | 512 MiB | 32 GiB |
| Graph nodes | 2^24 | 2^30 |
| Binary Merkle depth | 24 | 30 |
| Layers / partitions | 17 / 63 | 17 / 63 |
| Minimum challenges per layer across partitions | 750 | 750 |
| Challenges per layer per partition | 12 | 12 |
| Actual challenges per layer across partitions | 756 | 756 |
| Total challenge instances / proof bytes | 12,852 / 12,096 | 12,852 / 12,096 |
| Default parameter directory | `.cache/zigzag-512-parameters` | `.cache/zigzag-32g-parameters` |
| Parameter-directory override | `BENCH_ZIGZAG_512_PARAMETER_DIR` | `BENCH_ZIGZAG_32G_PARAMETER_DIR` |

512 MiB uses the existing benchmark-only `zigzag-512` proof profile. The 32 GiB
command uses native 32 GiB data geometry with a benchmark-only proof budget and
a process-local 17-layer override. It does not pass a named `--profile` to the binary. Its
`benchmark.profile` remains null; sector and proof-budget fields remain explicit
in `report.json`, and the wrapper aggregate is named `zigzag-32g`. Both wrappers
validate the reported geometry, prewarm agreement,
proof length, verification and recovered byte count.

The 32 GiB command accepts `2`, `11`, `15`, `17`, `19`, `22`, or `25` layers
(default: `17`), e.g. `BENCH_PROOF_MICRO_LAYERS=11 just bench-zigzag-32g`.
The benchmark-only 512 MiB profile has a fixed 17 layers. Registered sector
configurations, including SDR, are unchanged.

`minimum_challenges=750` is split across 63 partitions by rounding up:
`ceil(750 / 63) = 12`, giving 756 challenges per layer and 12,852 across 17 layers.
This meets the report's numerical 750-per-layer target, but does not establish
its security claim for the current filtered expander; that graph mismatch remains open.
Registered SDR/Curio proof parameters are not changed.

The Rust implementation is committed and pinned; rebuild the images with
`just build` to use it. Groth16 parameters depend on challenges per partition: previous 16-, 17- or 18-challenge
circuits and the old 2-challenge 8 MiB circuit cannot supply the new
12-challenge circuit. Prewarm generates the matching parameters on a cache miss;
parent tables and same-geometry raw-unseal fixtures remain reusable.

Both commands default to parent buffer 32768, parent and TreeR DONTNEED enabled,
`MALLOC_ARENA_MAX=4`, compact loader, Groth16 batch 1, and 100 GiB base RAM.
They enable encode prehash, the binary TreeR builder, the stream layer pipeline,
automatic TreeR threads and 64 MiB snapshot buffers. Query cache defaults to
0 bytes (disabled): the measured container and prewarm both get 100 GiB.
For example, these explicit overrides enable 4 GiB of query cache and increase
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

## Shared raw-unseal defaults

The host runner applies these defaults to all ZigZag sector sizes and modes,
including `prepare-fixture` and `unseal-only`. Existing `BENCH_*` overrides
take precedence, followed by native `FIL_PROOFS_*` settings where supported.
The 8 MiB and 512 MiB commands retain their named proof profiles; the general
runner and unseal-only default to an empty `BENCH_PROOF_MICRO_PROFILE`.

| Setting | Default |
| --- | --- |
| Layers | `17` (fixed for the named 8 MiB / 512 MiB profiles) |
| Base RAM / query cache | `107374182400` bytes (100 GiB) / `0` |
| Large sectors / parent cache | Enabled |
| Rayon / decode threads | `auto` / `auto` |
| Decode parent reader / buffer | `buffered` / 64 MiB |
| Decode mode / storage / block | `blockwise` / `auto` / 64 MiB |
| Unseal output / chunk | `stream` / 64 MiB |
| Decode field / batch / SHA | `limbs` / 8 nodes / `serial` |
| Prefix reuse / prefetch | Enabled / enabled |
| Decode profiling interval | `0` (disabled) |
| Unseal range offset / size | `0` / empty (all remaining bytes) |
| Prune BuildKit after benchmark | `0` (disabled) |

These are benchmark defaults; native Rust, Curio and SDR defaults are unchanged.
The raw-unseal settings alone do not require rebuilding an image containing
fast-unseal stages 1–4; the new proof budget above does. For fixtures made with another
layer count, pass the matching `BENCH_PROOF_MICRO_LAYERS` explicitly.

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
Groth16 batch size 1. Its proof budget now matches the larger benchmarks, so it
is no longer the former lightweight 2-partition / 2-challenge proof.

| Property | Development value |
| --- | --- |
| Padded sector / nodes / binary Merkle depth | 8 MiB / 2^18 / 18 |
| Layers / partitions | 17 / 63 |
| Minimum challenges / challenges per layer per partition | 750 / 12 |
| Actual challenges per layer / total challenge instances | 756 / 12,852 |
| Proof bytes | 12,096 |
| Prewarm RAM limit / setup allocation budget | 100 GiB / 40 GiB |
| Full-run RAM limit | 100 GiB; query cache disabled |
| Parameter directory | `.cache/zigzag-8-parameters` |
| Parameter-directory override | `BENCH_ZIGZAG_8_PARAMETER_DIR` |

The profile is fixed and benchmark-only (`zigzag-bench` feature). Registered
proof configurations and SDR are unchanged. The smaller sector is still not
a reliable predictor of 32 GiB I/O or unseal performance.
Full proofs must verify, and the entire unsealed payload must match the input.
The runner rejects reports with a different proof budget or geometry.

The new Rust benchmark budget is committed and pinned. Rebuild with
`just build`, which fetches the pinned sources first. An old image has the
previous proof budget. On an ARM Mac,
use the native Linux ARM64 image. The shared 100 GiB container limit is a cap,
not a reservation or measured requirement. The former 12 GiB development cap
has not been validated for this larger proof budget.
Likewise, the 40 GiB setup allocation budget is an admission setting for parameter
generation, not a measured Groth16 C2 requirement. Peak C2 memory for this 8 MiB
profile needs measurement; the FABLE plan's 40 GiB target concerns an optimized
32 GiB prover and cannot be applied directly to this profile.

Parameters are reused automatically on subsequent runs. Parent tables may be
reused via `BENCH_ZIGZAG_PARENT_CACHE_DIR` from a previous matching 8 MiB run;
32 GiB / 512 MiB tables and Groth16 parameters are not interchangeable with this
profile. Reports remain JSON and Markdown under `.runtime/runs/`, with aggregate
directories ending in `zigzag-8-baseline`. The standard `BENCH_*` optimization
overrides still apply. Raw unseal uses the shared optimized defaults above.
