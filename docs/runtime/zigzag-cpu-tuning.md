# ZigZag CPU scheduling and cache residency

This implements the CPU controls and optional cache experiments. It keeps one complete `just bench-zigzag-512` run,
including a newly produced and validated C1, all C2 partitions, verify and unseal.
No faster profile has been selected: Rust correctness tests, image builds and full
performance comparisons still require the authorized remote machine. Encode
defaults remain affinity on, two producers, stride 128 and lookahead 4096.
Record buffering and both DONTNEED options default to off in the general runner
and Curio. `just bench-zigzag-512` applies its own
[comparison preset](zigzag-512-baseline.md): parent buffer 32768, both DONTNEED
options on, `MALLOC_ARENA_MAX=4`, compact loader, batch 1 and 50 GiB RAM.
Optional [layer overlap and streaming snapshots](zigzag-layer-pipeline.md) use
a separate bounded TreeR pool and snapshot buffers; the baseline remains
sequential until full performance acceptance.

Optional [SHA prefix preparation](zigzag-encode-prehash.md) moves complete
SHA data blocks into the existing feeders. It is independent of the TreeR
pipeline and remains opt-in pending full performance comparisons.

## Runtime controls

The wrapper passes settings explicitly with Docker `-e` to both prewarm and
measured processes. Native variables are supported; `BENCH_*` takes precedence.

| Benchmark variable | Native variable | General runner default / permitted values |
| --- | --- | --- |
| `BENCH_RAYON_NUM_THREADS` | `RAYON_NUM_THREADS` | `auto`, or 1–4096 |
| `BENCH_EC_GPU_NUM_THREADS` | `EC_GPU_NUM_THREADS` | `auto`, or 1–4096 |
| `BENCH_ZIGZAG_PARAMETER_LOADER` | `FIL_PROOFS_ZIGZAG_PARAMETER_LOADER` | `compact`; `compact` or `mapped`, see [compact parameters](zigzag-compact-parameters.md) |
| `BENCH_ZIGZAG_QUERY_CACHE_BYTES` | `FIL_PROOFS_ZIGZAG_QUERY_CACHE_BYTES` | 0; optional [per-C2 query cache](zigzag-query-cache.md), up to 60 GiB |
| `BENCH_ZIGZAG_QUERY_CACHE_RESERVE_BYTES` | `FIL_PROOFS_ZIGZAG_QUERY_CACHE_RESERVE_BYTES` | Benchmark: base budget (50 GiB); generic Rust/Curio: 56 GiB |
| `BENCH_ZIGZAG_MULTICORE_ENCODE` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE` | 1; boolean |
| `BENCH_ZIGZAG_ENCODE_AFFINITY` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_AFFINITY` | 1; boolean |
| `BENCH_ZIGZAG_ENCODE_PRODUCERS` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS` | 2; wrapper accepts 1–128, screen 1/2/3/4 |
| `BENCH_ZIGZAG_ENCODE_STRIDE` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE` | 128; 1–262144 |
| `BENCH_ZIGZAG_ENCODE_LOOKAHEAD` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD` | 4096; 1–262144 |
| `BENCH_ZIGZAG_USE_PARENT_CACHE` | `FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE` | 1; boolean |
| `BENCH_PARENT_CACHE_WINDOW_NODES` | `FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE` | Existing mmap window; screen 2048/32768/262144 |
| `BENCH_ZIGZAG_PARENT_BUFFER_NODES` | `FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES` | 0; 0–262144 per encode reader |
| `BENCH_ZIGZAG_PARENT_CACHE_DONTNEED` | `FIL_PROOFS_ZIGZAG_PARENT_CACHE_DONTNEED` | 0; boolean |
| `BENCH_ZIGZAG_TREE_R_DONTNEED` | `FIL_PROOFS_ZIGZAG_TREE_R_DONTNEED` | 0; boolean |
| `BENCH_ZIGZAG_TREE_R_BUILDER` | `FIL_PROOFS_ZIGZAG_TREE_R_BUILDER` | `legacy`; opt-in `binary`, see [bounded TreeR builder](zigzag-merkle-builder.md) for acceptance |
| `BENCH_ZIGZAG_GROTH16_BATCH_SIZE` | Wrapper emits `FIL_PROOFS_ZIGZAG_GROTH16_BATCH_SIZE` | 1 for 512 MiB/32 GiB; screen 1/2 |
| `BENCH_ZIGZAG_SETUP_WORKERS` | `FIL_PROOFS_ZIGZAG_SETUP_WORKERS` | `auto`; or explicit 1–128, see [automatic prewarm](zigzag-auto-prewarm.md) |
| `BENCH_ZIGZAG_MALLOC_ARENA_MAX` | Wrapper emits `MALLOC_ARENA_MAX` | Unset; explicit 1–256, diagnostic candidate 4 |

The allocator override applies only to dedicated ZigZag benchmark containers
(prewarm and full run). It needs no image rebuild, does not inherit host
`MALLOC_ARENA_MAX`, and does not change Curio, SDR or host services. Keep it unset
in the general runner for the allocator baseline; `just bench-zigzag-512`
supplies `4` unless explicitly overridden. Reports record the requested override and the
container-reported environment. These fields are not measurements of arena count
or free allocator memory. The report writer corrects the older binary's static
"no tuning applied" description; raw `summary.json`/stderr retain the original
binary output. Do not declare a lower memory budget validated before all
partitions, proof verification and unseal have completed.

ZigZag's compact parameter loader decodes each query family into one initialized
destination vector, filling its slots in parallel. This avoids the temporary
vectors and final merge used by Rayon's parallel `Result<Vec<_>>` collection
([upstream implementation](https://raw.githubusercontent.com/rayon-rs/rayon/v1.10.0/src/result.rs),
[vector collection](https://raw.githubusercontent.com/rayon-rs/rayon/v1.10.0/src/iter/extend.rs)).
The Bellperson `Arc<Vec<Affine>>` interface and checked/unchecked point validation
are preserved. This allocation change is independent of `MALLOC_ARENA_MAX`;
limiting arenas alone is not sufficient evidence that repeated C2 batches fit.

Dedicated ZigZag benchmark containers use `--oom-score-adj=1000`, making the
disposable benchmark a preferred victim if the shared host exhausts memory.
The final container JSON records this value. This applies to prewarm and full
benchmark containers, not Curio or SDR, and does not reserve host RAM or replace
the cgroup limit. Leave headroom for other services; a late user-space monitor
cannot guarantee recovery once the host is already thrashing.

For Rayon/ec-gpu, `auto` resolves inside the container before static settings or pools initialize.
The runner uses its process's available parallelism. Rayon and ec-gpu are separate
pools. Inspect actual cpuset, physical cores and SMT before choosing explicit
sizes; do not assume a historical host's vCPU count. Every variant needs a fresh
process.

### Worker sizing across sealing and unsealing

The 128-worker update and automatic prewarm are included in the current
`rust-fil-proofs` pin. Fetch managed sources and rebuild the dedicated images
before using them. Shell configuration alone cannot change an existing image's
Rust limit. Their remote Rust validation remains deferred.

| Work | Automatic sizing and limits |
| --- | --- |
| TreeD, parent-table generation, compact parameter decoding, parallel vanilla work | Use the available Rayon pool; no additional ZigZag 32/64-worker cap. |
| Binary TreeR, sequential mode | Up to `min(Rayon threads, 128, first-level chunks)`. |
| Binary TreeR, overlap/stream | Private pool up to 128, leaving room for the encoder and configured feeders. With Rayon=96 and the default two feeders, `auto` selects 93. |
| Groth16 proving | Uses Rayon and ec-gpu CPU pools, each `auto` or explicitly 1–4096. Batch/partition size and sequential synthesis still limit usable concurrency; these are not worker caps. |
| Unseal decode | Uses Rayon for independent output chunks. Layers remain sequential; scratch copy and output writes are not automatically parallelized across all CPUs. |
| Groth16 parameter generation | `auto` selects H and query workers independently, up to 128, bounded by available CPUs, Rayon, work and RAM. Explicit 1–128 remains supported. Domain/FFT work uses its ec-gpu pool. |
| Encode feeders | Explicit two-feeder default plus one sequential consumer; the wrapper accepts 1–128 feeders. Direct Rust settings do not impose this wrapper cap. |

`auto` reflects CPUs available to the process/container, not necessarily all
physical CPUs in the host and not currently idle CPUs. The benchmark resolves
it through Rust `available_parallelism`; the Curio launcher uses `nproc` with
the process's affinity/cpuset. Explicit Rayon/ec-gpu counts can oversubscribe
the available CPUs. The pools are separate and their sizes must not be added
as a count of exclusively reserved cores.

Leave prewarm at `auto` when moving to a larger host. The generator checks its
configured budget, Linux host/cgroup headroom and phase-specific allocation
estimates before selecting H/query workers. The default benchmark budget stays
40 GiB inside the 50 GiB prewarm container. Auto is an admission policy, not a
memory reservation or a guarantee that 128 workers are fastest. Explicit counts
retain the previous manual scheduling and memory-floor check.

Encoder feeders remain at two; this change does not autotune them. More feeders
multiply parent-reader buffers and do not remove the sequential encoder
dependency. See [automatic prewarm](zigzag-auto-prewarm.md) for selection rules,
report fields and the pending remote Rust validation.

TreeR's maximum reusable vector allocation rises from 40 to 80 MiB only when
more workers are actually selected; existing pools of at most 64 keep their
previous allocation. The snapshot pool and dirty-write windows retain their
64 MiB limits. Shared SDR code and pool defaults are unchanged.

`summary.json` and `report.json` include `cpu_configuration`: actual Rayon pool
size, configured ec-gpu size, allowed CPU list, effective stride/lookahead,
requested values, parent mmap setting and cache policy. `cpu_diagnostics` retains
selected consumer/producer CPUs, binding/restoration, fallback reasons and advice
results from `stderr.log`. `summary.md` includes the configuration. Actual mmap
windows are aligned and bounded by the graph; their size is logged. Existing
phase/layer CPU/RAM, faults, I/O, PSI, swap and OOM measurements remain available.

## Bounded records and advice

Encode readers copy consecutive little-endian u32 records into owned bounded
buffers, crossing existing mmap windows. Capacity is reserved once, including
when reverse traversal starts at a short tail. Direction changes the selected
record, not parent order. Duplicate parents and the parentless first node are
preserved. Remaps use the verified descriptor, never a replaced pathname. Decode
and ordinary parent-table preparation retain the existing reader.

At degree 14, 262144 nodes require at most 14 MiB of u32 storage per reader;
four readers require 56 MiB, plus mappings and the existing lookahead ring.
Zero avoids this allocation. Larger record buffers do not themselves reduce
mmap remap counts; compare mmap windows separately.

Parent-cache DONTNEED advises the traversed orientation only after successful
encoding and after all readers have joined and unmapped. Both directions use
the same rule. No active feeder range or interrupted traversal is advised.
Finer reclamation behind a shared frontier is deferred until profiles justify
tracking all readers, including idle feeders.

TreeR DONTNEED runs at C2 entry, after vanilla generation, C1 serialization and
semantic validation, immediately before loading Groth16 parameters. PC1 and C1
do not discard TreeR pages. The same boundary applies to the full benchmark,
FFI/Curio and the ordinary Rust proving API. Parent-cache advice is unchanged.

The optional local cache hint identifies only the expected layer stores. Each
regular file must match the validated C1 root and expected size before sync and
advice; symlinks are not followed. Missing, moved or inaccessible stores and
sync/advice failures are logged and skipped without failing C2. The portable
Rust C1 result and the original cache-independent C2 API remain unchanged. The
FFI v2 envelope carries an optional `tree_r_cache_path`; older envelopes remain
readable, and a successful C1 retry refreshes the hint after validation. A C2
worker on another host can prove without these files.

Reports record `groth16_tree_r_cache_release` inside the C2 phase, separately
from parameter loading and `groth16_c2`. `cpu_diagnostics` retains advice counts
and fallback logs. The FFI still syncs files/directories and publishes AUX last;
binary builder durability, preallocation and ENOSPC handling remain unchanged.
No TreeD, replica, parent-cache or parameter file is advised by this operation.

DONTNEED is advisory, not a RAM cap. Include C1 rereads and total sealing when
deciding whether it helps. All ZigZag benchmark modes default to a 50 GiB
(53687091200-byte) base budget. Full runs add requested query cache on top,
including 32 GiB sectors: 4 GiB cache gives a 54 GiB limit. The cache reserve
defaults to the base; explicit mismatches are rejected. Prewarm, fixture
preparation and standalone unseal use only the base. Standalone prewarm retains
its separate override. Docker memory-swap equals memory, disabling extra swap.
Active-cache totals must fit the loader's 60 GiB ceiling; other overrides are
capped at 80 GiB. SDR and Curio services do not inherit these limits. Docker
enforces the total, not separate base/cache partitions. The new memory policy
requires full-run acceptance on the remote machine.

## Curio and build variants

`devnet_compose` adds [compose.zigzag-cpu.yaml](../../docker/compose.zigzag-cpu.yaml)
only for ZigZag, passing native pool, encode, buffer, residency and optional batch
settings to dedicated Curio. Standard SDR compose, image, pools and SHA features
remain unchanged. Curio's mmap window uses `DEVNET_PARENT_CACHE_WINDOW_NODES`;
its existing parent-cache contract stays enabled. Cache on/off is exposed in the
full benchmark.

Dedicated `curio` and `sptool` launchers validate settings and resolve `auto` from
their allowed CPUs before Go/FFI starts. Ordinary and split PC1 use FileReplica
and the same Rust `replicate_layers`, rather than a benchmark-only algorithm.
Overlay/source digests include the launcher and settings helper. Export native
settings before lifecycle commands, keep them for later Compose invocations,
and restart the worker to change static pools. Actual Curio and a small SDR
lifecycle remain remote acceptance checks.

Both dedicated build scripts accept independent controls:

| Variable | Values | Default |
| --- | --- | --- |
| `DEVNET_ZIGZAG_TARGET_CPU` | `default`, `generic`, `native` | `default` |
| `DEVNET_ZIGZAG_LTO` | `off`, `thin`, `fat` | `off` |
| `DEVNET_ZIGZAG_SHA_ASM` | `0`, `1` | `0` |

`default` preserves the original build policy. `generic` enables `blst-portable`
in the microbench Cargo build and feature graph (recorded in manifest
`cargoFeatures`); Curio uses FFI_PORTABLE=1. This prevents BLST from choosing ADX
based on the build host. `native` targets the build machine. LTO uses
one codegen unit. Change one control at a time on the target host. No flag forces
SHA-NI. Optional `zigzag-sha-asm` is forwarded only by dedicated builds. Cargo
unification affects all sha2 users inside that process; do not enable it on the
standard SDR image.

Locked `cargo tree -e features` with selected FFI features is stored in the image
at `/usr/local/share/zigzag/cargo-features.txt`. The benchmark copies it beside
the report and records its hash in provenance. Manifest `cpuBuild`, image labels
and tag identity record build options; different options do not share a tag.
SHA-NI eligibility is separate from build/backend evidence. KDF uses sha2::Sha256;
sha2raw or sha2-asm appearing in a lock does not prove assembly was used. Pinned
sha2 0.10.8 on x86 checks SHA, SSE2, SSSE3 and SSE4.1 before selecting SHA-NI;
inspect the actual graph/backend separately on other architectures.

## Acceptance

Run builds, Rust fixtures and benchmarks only in the checkout on the remote
machine. The lock pins the published Rust revision
`b1cec2213b8132adc6164ccb5a289c35e279eadf`, including the cache_policy module,
reader, encoder, feature and direct Groth16 query decoding, plus the optional
per-C2 query cache with corrected cgroup-v2 root-limit detection and
circuit-preparation measurements. Query retention remains off by default. Fetch the updated
managed sources and rebuild both dedicated images from the same source digest.
For further uncommitted development,
use an isolated copy selected by DEVNET_RUST_FIL_PROOFS_SOURCE; never edit managed
checkouts.

The pinned revision includes the deferred TreeR policy described in
[required capabilities](zigzag-capabilities.md). Fetch the managed sources and
rebuild the dedicated images. Keep further source edits unstaged for manual review.

Remote Rust tests cover cache_policy, buffered records across mmap boundaries,
both traversals, uncached-reference encode with 1/2/3/4 producers, ring wrapping,
error/panic/spawn cancellation and the ignored live-affinity restoration test.
The latter also checks a subsequent Rayon pool's inherited mask. Existing
ignored API/FFI proof lifecycle tests and actual Curio sealing remain required.

Screen one full run per selected variant with identical data, IDs, parameters,
layers, challenges and partitions. Compare affinity on/off, batch 1/2, a small
independent-pool matrix based on physical cores/SMT, then producers 1/2/3/4 and a
few stride/lookahead choices. Compare buffering and mmap windows separately,
then cache on/off and advice. Batch 4+ needs demonstrated memory headroom.
Compare build variants separately after inspecting features and CPU flags.
No separate PC1/TreeR/C2 benchmark or automatic expensive matrix is added.

For example, one selected full run on the remote host:

```sh
BENCH_RAYON_NUM_THREADS=8 BENCH_EC_GPU_NUM_THREADS=8 \
BENCH_ZIGZAG_ENCODE_PRODUCERS=3 BENCH_ZIGZAG_GROTH16_BATCH_SIZE=1 \
just bench-zigzag-512
```

Reuse BENCH_ZIGZAG_512_PARAMETER_DIR. Preserve baseline reports, cache state,
cpuset, hardware and filesystem evidence. Accept variants only with correct
commitments/proof/unseal, memory headroom and improvement in the target phase
and total sealing beyond noise. The `zigzag-512` comparison preset above has
been selected; other candidate defaults require separate acceptance.

Local checks: `npm --prefix tools run test:cpu-settings`,
`npm --prefix tools run test:measurements`, shell/Node syntax, Rust formatting
and locked offline Cargo metadata. Mock workers/Docker and small report data
do not establish PoRep correctness or speedup.

### Deferred TreeR advice validation (2026-10-16)

An isolated development checkout on the remote machine built the dedicated
microbench image with Rust source digest
`702a4a79f1bd7e0fa59108cf0907c45580e4b4f0d7ee31fb504a6dfa6c322095`.
These sources are now committed as
`7a94e1cfe322a9908dd17ab5a09c9cf96029b073`, which is included in the current
`versions.lock.yaml` pin. The results below apply to that revision, not the
later automatic-prewarm and worker-limit changes.
Five cache-policy tests passed, including mismatched roots/lengths, missing
stores, symlinks/FIFOs, disabled advice and preservation of file contents.
The integration fixture passed in five fresh processes: legacy/sequential,
binary/sequential, binary/overlap, binary/stream, and binary/stream with advice
disabled. It checks C1 validation before release, release before the parameter
loader in split and ordinary APIs, and missing-cache/cache-independent C2.
The FFI C1 retry test passed, including older v2 envelopes without the hint.

Three full 2 KiB cycles (legacy advice on, stream advice on/off) passed proof
verification and byte-for-byte unseal, with identical persisted trees/replicas.
Their reports place `groth16_tree_r_cache_release` only in C2, after all C1
phases and before loading. Tiny 2 KiB stores have no complete discardable page;
the 16 KiB cache-policy fixture exercises actual full-page advice. These are
correctness checks, not a 512 MiB/32 GiB residency or performance acceptance.
Tests used 8 GiB/4 CPU containers, full cycles 12 GiB/4 CPU, with no extra swap.
Evidence is retained in `.runtime/tree-r-c2-20261016` on the remote machine.
Local checks passed 31 report/configuration tests and the required-API guard
test, plus formatting and syntax checks. No full 512 MiB benchmark or live
Curio sealing was run for this change.
