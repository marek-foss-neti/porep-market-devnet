# Shared ZigZag benchmark commands

Use the small sector for development iterations and the larger sector to check
behavior at production size. Run benchmarks only on the remote machine.

```sh
just bench-zigzag-512
just bench-zigzag-32g
```

Each command performs one complete prewarm and seal/prove/verify/unseal run.
Both use [bench-zigzag.sh](../../scripts/bench-zigzag.sh), the same dedicated
ZigZag image and the same [comparison preset](zigzag-512-baseline.md).
Changing a default in that runner applies to both commands. Existing `BENCH_*`
overrides work for both; use identical overrides when comparing improvements.
Adding the command does not require an image rebuild or a Rust dependency repin.

| Property | `bench-zigzag-512` | `bench-zigzag-32g` |
| --- | --- | --- |
| Padded sector | 512 MiB | 32 GiB |
| Graph nodes | 2^24 | 2^30 |
| Binary Merkle depth | 24 | 30 |
| Layers / partitions | 11 / 10 | 11 / 10 |
| Minimum challenges | 176 | 176 |
| Challenges per layer per partition | 18 | 18 |
| Total challenge instances / proof bytes | 1,980 / 1,920 | 1,980 / 1,920 |
| Default parameter directory | `.cache/zigzag-512-parameters` | `.cache/zigzag-32g-parameters` |
| Parameter-directory override | `BENCH_ZIGZAG_512_PARAMETER_DIR` | `BENCH_ZIGZAG_32G_PARAMETER_DIR` |

512 MiB uses the existing benchmark-only `zigzag-512` proof profile. The 32 GiB
command uses the existing native 32 GiB configuration, which already has this
proof budget. It does not pass an invented `--profile` to the binary. Its native
`benchmark.profile` remains null; sector and proof-budget fields remain explicit
in `report.json`, and the wrapper aggregate is named `zigzag-32g`. Both wrappers
reject layer overrides and validate the reported geometry, prewarm agreement,
proof length, verification and recovered byte count.

Both commands default to parent buffer 32768, parent and TreeR DONTNEED enabled,
`MALLOC_ARENA_MAX=4`, compact loader, Groth16 batch 1, and 50 GiB base RAM.
They enable encode prehash, the binary TreeR builder, the stream layer pipeline,
automatic TreeR threads and 64 MiB snapshot buffers. Query cache defaults to
10737418240 bytes (10 GiB), added above the base: the measured container gets
60 GiB and prewarm gets 50 GiB. For example, these explicit overrides reduce
the measured container to 54 GiB while retaining 50 GiB for prewarm:

```sh
BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296 just bench-zigzag-512
BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296 just bench-zigzag-32g
```

Use identical overrides on both commands for comparisons. To select the older
CPU path, set both `BENCH_ZIGZAG_TREE_R_BUILDER=legacy` and
`BENCH_ZIGZAG_LAYER_PIPELINE=sequential`; prehash and query cache can be disabled
independently with their `BENCH_*` settings set to `0`. The current loader permits
base plus active query cache up to 60 GiB; see [memory policy](zigzag-query-cache.md).
Pool sizes set to `auto` resolve against the actual container CPU availability.

Groth16 parameter generation now defaults to [automatic prewarm](zigzag-auto-prewarm.md)
for both commands, with H/query worker counts selected from CPU availability and
memory headroom. `BENCH_ZIGZAG_SETUP_WORKERS=16` restores the explicit count;
the generator budget stays 40 GiB and the prewarm container stays at 50 GiB.
Unlike adding the shared command, this Rust change requires fetching the updated
pinned source and rebuilding the image. Rust tests and
fresh-parameter acceptance are deferred until the active remote benchmark ends.

Parameter files depend on sector geometry. Prewarm validates/reuses the proper
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
