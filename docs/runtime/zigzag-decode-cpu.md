# ZigZag CPU raw-unseal kernels

These optional experiments target the bulk decoder's parent gather, SHA-256 KDF
and scalar subtraction. They apply to ping-pong, blockwise and streamed final-layer
decode. The original decoder remains the default. Encoding, single-node
verification, SDR, proof geometry and the sealed format are unchanged. No new
default or speedup has been accepted without a full raw-unseal comparison.

## Controls

Native variables start with `FIL_PROOFS_ZIGZAG_DECODE_`; corresponding
`BENCH_ZIGZAG_DECODE_` variables override them in the dedicated runners.

| Suffix | Default | Values and effect |
| --- | --- | --- |
| `FIELD` | `reference` | `reference` / `limbs`: original `Fr` conversion or canonical four-limb subtraction |
| `SHA` | `serial` | `serial` / `interleaved`: finish each message or update active messages one SHA block at a time |
| `BATCH_NODES` | `1` | 1–32 independent nodes per worker batch |
| `PREFIX_REUSE` | `0` | 0/1: reuse complete SHA blocks of the common boundary-parent prefix |
| `PREFETCH` | `0` | 0/1: validated parent-address hints before gathering the batch |
| `PROFILE_EVERY` | `0` | 0 disables loop clocks; 1–1048576 samples every Nth batch per worker |
| `THREADS` | `auto` | `auto` / 1–128; cap decoder stripes without changing the global Rayon pool |

Native Boolean values are 0/1; benchmark aliases are normalized by the shell.
Invalid values fail validation. Settings are snapshotted for a multilayer decode
session. With every default, the previous path executes. Profiling or an explicit
thread cap also selects the instrumentable batched path, even with reference
SHA and field arithmetic. `ENCODE_PREHASH` still affects only encoder feeders.
No new global SHA Cargo feature, CPU target or GPU requirement is introduced.

## Correctness and resource boundaries

The limb kernel checks canonical little-endian operands, subtracts modulo the
BLS12-381 scalar modulus with borrow across four `u64` limbs, and conditionally
adds the modulus. It avoids Montgomery `Fr` conversion. SHA output still has its
highest two bits cleared in byte 31, exactly as in `bytes_into_fr_repr_safe`.
Only concrete Poseidon/SHA256/Blake2s hashers use the shortcut. Other hashers
retain `encode::decode` and log `field_fallback=unsupported_domain`. Unsupported
parent degree (outside 1–32) or replica-ID length uses the previous kernel.
Exact type identification adds a `'static` bound to bulk ZigZag decode hashers;
the MerkleTree hasher contract already provides it. The single-node API is unchanged.

Both SHA schedules use `sha2::Sha256` with its existing runtime hardware dispatch
and software fallback. `interleaved` is block-round-robin scheduling, **not a new
SIMD SHA kernel**; it may lose to serial hardware hashing. The microbench records
x86 SHA-NI and ARM SHA2 eligibility separately. Eligibility is not an instruction
trace or proof that a particular build used hardware SHA.

Prefix reuse caches incremental SHA states after complete 64-byte blocks of
`replica_id || repeated_encoded_boundary_value`. The per-layer object captures
the original boundary before blockwise overwrite. A node reuses only blocks
covered by its actual leading boundary-parent indices. Parent order, duplicates,
remaining bytes, message length and SHA padding stay identical. The special node
hashes only the 32-byte ID; the standard 14-parent message is still 480 bytes and
eight compressions before reuse. Prefix construction is separately reported work.
States cannot cross calls, replicas, orientations or layers. Intermediate layers
retain reverse-topological traversal and join-before-copy-back; the streamed
final layer reads immutable input.

Each worker reuses one fixed batch allocation. Parent indices are checked before
prefetch addresses or loads are formed. x86-64/AArch64 use architectural hints;
other targets safely omit them. Cancellation is checked between batches and
before returning; failed blocks are not copied back. Retry starts with fresh
private state from sealed input and a reset/replaced output.

The new path caps workers by the requested count, Rayon pool,
`available_parallelism` (process affinity/CPU quota) and 128. Detection failure
conservatively selects one worker. Stripe geometry and the existing aggregate
parent-buffer budget may lower this further. No global affinity or NUMA policy
is changed, and no assumption is made that SMT is faster.

Even 128 workers with 32-node batches need less than 8 MiB of additional kernel
workspace. FFI RAM admission reserves the configured maximum, so changing
quota/affinity after admission cannot increase this workspace beyond its budget.
Sector buffers, parent buffers/tables, FR32 output, allocator overhead and the
existing reserve remain additional. Prefix capacity is bounded; there is no
per-field allocation or cross-call cache.

## Reports and comparison

`cpu_configuration.decode_cpu` records requests (`threads: null` means auto).
`report.json` preserves `zigzag_decode_cpu` events: actual field/fallback,
workers, workspace, nodes, batches, prefix histogram, logical/reused SHA blocks
and prefix setup work. Markdown shows sampled gather/SHA/field times alongside
the existing FR32/writer diagnostics. Gather includes parent reads/validation,
prefetch, message copies and prefix selection. Field includes masking,
subtraction/conversion and output writes.

Sampled worker wall intervals can overlap and include descheduling. They are
neither phase wall time nor exclusive CPU time; missing samples are unavailable,
not zero. Do not add/extrapolate them into total raw unseal. Prefix setup work
is separate from reused blocks, so reuse counters alone are not a net speedup.

Devnet pins the committed CPU decoder implementation at Rust revision
`46f7dd618ddfe9cfd11ada83434ac35f7a245990`, including the required
`decode_cpu::DecodeCpuConfig` API. Publish this commit, fetch the managed sources
and rebuild the dedicated image; no development-source override is required.
Flags alone cannot update an old image. The repin does not establish full
Rust/FFI validation or a measured speedup.

Candidate command for an existing 512 MiB / 17-layer fixture:

```sh
BENCH_ZIGZAG_DECODE_FIELD=limbs \
BENCH_ZIGZAG_DECODE_BATCH_NODES=8 \
BENCH_ZIGZAG_DECODE_SHA=serial \
BENCH_ZIGZAG_DECODE_PREFIX_REUSE=1 \
BENCH_ZIGZAG_DECODE_PREFETCH=1 \
BENCH_ZIGZAG_DECODE_THREADS=auto \
BENCH_ZIGZAG_DECODE_PROFILE_EVERY=0 \
BENCH_ZIGZAG_DECODE_PARENT_READER=buffered \
BENCH_ZIGZAG_DECODE_MODE=blockwise \
BENCH_ZIGZAG_UNSEAL_OUTPUT=stream \
BENCH_PROOF_MICRO_PROFILE= \
BENCH_PROOF_MICRO_LAYERS=17 \
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
BENCH_ZIGZAG_FULL_MEMORY_BYTES=8589934592 \
BENCH_ZIGZAG_QUERY_CACHE_BYTES=0 \
BENCH_PRUNE_BUILDKIT_AFTER_BENCH=0 \
just bench-proof-micro-unseal zigzag 512mib \
  "$PWD/.runtime/proof-micro-fixtures/zigzag-512mib-17layers"
```

Keep fixture, parent reader, storage, output, memory limit and cache conditions
identical. First isolate `FIELD=limbs`; then compare batches 1/4/8/16, prefix
off/on, prefetch off/on and serial/interleaved SHA. Use `PROFILE_EVERY=64` for
diagnosis and disable profiling for acceptance. Compare thread caps separately;
physical-core/SMT and NUMA first-touch tests must record topology and placement.
Validate 512 MiB, then full 32 GiB / 17-layer raw unseal before choosing defaults.

## Validation — 9 November 2026

- Passed five isolated tests compiling the actual kernel modules with cached
  dependencies: independent BigUint scalar arithmetic (boundaries and 4,096
  random pairs), reference SHA message construction, both orientations,
  degrees 1/2/13/14/15/32, batches 1/2/4/8/32, prefix reuse, prefetch, partial
  stripes, blockwise boundary lifetime, Domain fallback, invalid parents,
  noncanonical values, cancellation and CPU/workspace bounds. Clippy passed for
  those modules. These are correctness tests, not benchmarks.
- Passed 39 lightweight configuration/measurement/report tests and the targeted
  required-API build guard test, including forwarding settings to Docker,
  actual/fallback diagnostics, absent samples and unchanged total timers.
- Added full integration coverage against existing encoder/Fr arithmetic for
  Poseidon/SHA256/Blake2s, both orientations, 2/11/17 layers, three parent readers
  and ping-pong/blockwise/streaming. It remains unexecuted locally.
- Offline workspace dependency resolution still fails on missing `dialoguer`
  before integration/FFI compilation. Full builds, integration checks, x86/ARM
  hardware-backend validation, topology comparisons and performance acceptance
  remain outstanding. No benchmark, prewarm or remote test was launched.

Targeted Rust checks on an available test machine, with an isolated parent cache:

```sh
cargo test --locked --no-default-features -p storage-proofs-porep --lib zigzag::decode_cpu
cargo test --locked --no-default-features -p storage-proofs-porep --lib \
  zigzag::vanilla::vde::decode_cpu_tests
```

Repeat integration with parent cache enabled and disabled, then the existing
public unseal/FFI tests with candidate flags. Sealed and unpadded bytes must
match the reference. No measured speedup is claimed by this implementation.
