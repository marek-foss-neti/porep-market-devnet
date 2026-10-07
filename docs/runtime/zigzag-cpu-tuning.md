# ZigZag CPU scheduling and cache residency

This implements the CPU controls and optional cache experiments from Etap 1 of
`PROMPT-PLAN-FAST-SEAL.md`. It keeps one complete `just bench-zigzag-512` run,
including a newly produced and validated C1, all C2 partitions, verify and unseal.
No faster profile has been selected: Rust correctness tests, image builds and full
performance comparisons still require the authorized remote machine. Encode
defaults remain affinity on, two producers, stride 128 and lookahead 4096.
Record buffering and both DONTNEED options default to off.

## Runtime controls

The wrapper passes settings explicitly with Docker `-e` to both prewarm and
measured processes. Native variables are supported; `BENCH_*` takes precedence.

| Benchmark variable | Native variable | Default / permitted values |
| --- | --- | --- |
| `BENCH_RAYON_NUM_THREADS` | `RAYON_NUM_THREADS` | `auto`, or 1–4096 |
| `BENCH_EC_GPU_NUM_THREADS` | `EC_GPU_NUM_THREADS` | `auto`, or 1–4096 |
| `BENCH_ZIGZAG_MULTICORE_ENCODE` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE` | 1; boolean |
| `BENCH_ZIGZAG_ENCODE_AFFINITY` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_AFFINITY` | 1; boolean |
| `BENCH_ZIGZAG_ENCODE_PRODUCERS` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS` | 2; 1–64, screen 1/2/3/4 |
| `BENCH_ZIGZAG_ENCODE_STRIDE` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE` | 128; 1–262144 |
| `BENCH_ZIGZAG_ENCODE_LOOKAHEAD` | `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD` | 4096; 1–262144 |
| `BENCH_ZIGZAG_USE_PARENT_CACHE` | `FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE` | 1; boolean |
| `BENCH_PARENT_CACHE_WINDOW_NODES` | `FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE` | Existing mmap window; screen 2048/32768/262144 |
| `BENCH_ZIGZAG_PARENT_BUFFER_NODES` | `FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES` | 0; 0–262144 per encode reader |
| `BENCH_ZIGZAG_PARENT_CACHE_DONTNEED` | `FIL_PROOFS_ZIGZAG_PARENT_CACHE_DONTNEED` | 0; boolean |
| `BENCH_ZIGZAG_TREE_R_DONTNEED` | `FIL_PROOFS_ZIGZAG_TREE_R_DONTNEED` | 0; boolean |
| `BENCH_ZIGZAG_GROTH16_BATCH_SIZE` | Wrapper emits `FIL_PROOFS_ZIGZAG_GROTH16_BATCH_SIZE` | 1 for 512 MiB/32 GiB; screen 1/2 |

`auto` resolves inside the container before static settings or pools initialize.
The runner uses its process's available parallelism. Rayon and ec-gpu are separate
pools. Inspect actual cpuset, physical cores and SMT before choosing explicit
sizes; do not assume a historical host's vCPU count. Every variant needs a fresh
process.

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

TreeR DONTNEED syncs each completed historical tree before advising full pages.
Sync errors fail replication; advice errors log fallback. All leaves/nodes and
roots remain available for C1. Sync/advice stays in that layer's TreeR interval.
The FFI still syncs files/directories and publishes AUX last. Preallocation,
private copies, retry and ENOSPC behavior remain. The active replica is never
advised; unsupported systems retain normal residency.

DONTNEED is advisory, not a RAM cap. Include C1 rereads and total sealing when
deciding whether it helps. Full 512 MiB/32 GiB containers are capped at 80 GiB
(85899345920 bytes), with memory-swap equal to memory; larger overrides fail.

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

Run builds, Rust fixtures and benchmarks only over SSH on the authorized host,
in `~/filecoin/porep-market-devnet`. The lock pins the published Rust revision
`9c954a9cae2ddc61110848fc348b92d04dddba36`, including the cache_policy module,
reader, encoder and feature. Fetch the updated managed sources and rebuild both
dedicated images from the same source digest. For further uncommitted development,
use an isolated copy selected by DEVNET_RUST_FIL_PROOFS_SOURCE; never edit managed
checkouts.

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
and total sealing beyond noise. Candidate defaults stay off until acceptance.

Local checks: `npm --prefix tools run test:cpu-settings`,
`npm --prefix tools run test:measurements`, shell/Node syntax, Rust formatting
and locked offline Cargo metadata. Mock workers/Docker and small report data
do not establish PoRep correctness or speedup. No remote result is claimed.

Suggested manual commit: `feat: tune ZigZag CPU scheduling and cache residency`.
