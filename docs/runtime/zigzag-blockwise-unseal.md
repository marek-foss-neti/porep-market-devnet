# ZigZag blockwise raw unseal

The optional blockwise decoder keeps one private sector state and one reusable
output block. For 32 GiB with a 64 MiB block, these buffers occupy **32 GiB +
64 MiB**, instead of two 32 GiB sector buffers. Parent buffers, resident parent
tables, runtime overhead and the output writer are additional memory.

The default remains `ping_pong`. A smaller working set is not a measured speedup:
blockwise decoding adds a copy-back pass per layer. Full 32 GiB A/B acceptance
must select the production mode and block size. The 64 MiB setting is an
experimental starting point; compare 16, 64 and 256 MiB. For an 8 MiB sector,
all three are capped at the sector size, so they do not demonstrate the memory
savings of a 32 GiB sector.

## Controls

| Benchmark variable | Native variable | Default / values |
| --- | --- | --- |
| `BENCH_ZIGZAG_DECODE_MODE` | `FIL_PROOFS_ZIGZAG_DECODE_MODE` | `ping_pong`; `ping_pong`, `blockwise` |
| `BENCH_ZIGZAG_DECODE_BLOCK_MIB` | `FIL_PROOFS_ZIGZAG_DECODE_BLOCK_MIB` | `64`; 1–256 MiB total, capped at sector size |
| `BENCH_ZIGZAG_DECODE_STORAGE` | `FIL_PROOFS_ZIGZAG_DECODE_STORAGE` | `auto`; `auto`, `file`, `ram` |

`BENCH_*` overrides the corresponding native variable. These settings reach the
dedicated ZigZag full and unseal-only runners. SDR is unchanged. Parent-reader
selection remains independent; see [parent readers](zigzag-decode-parents.md).

In blockwise mode:

- `file` uses one physically preallocated, unnamed private scratch file plus a
  bounded RAM output block. It does not modify or reflink the sealed input, and
  does not force intermediate-layer syncs. ENOSPC is reported before mmap.
- `auto` prefers a private RAM sector after admission. It checks host
  `MemAvailable` and the tightest observable cgroup memory headroom, including
  ancestor limits, through the existing ZigZag setup resource reader. Admission
  includes the sector, output block, any optional FR32 output buffer,
  configured parent-buffer budget, one active
  parent table, and a reserve of max(1 GiB, 10% of available memory). Only clean
  inactive cgroup file pages count as reclaimable. A process-local guard prevents
  two RAM unseals from concurrently admitting allocations from the same snapshot.
  Unavailable counters, insufficient headroom, a busy RAM decoder or a fallible
  allocation error select file storage before decoding starts.
- `ram` uses the same admission checks but returns an error instead of falling
  back. It requires blockwise mode. These checks are **not an OS reservation or
  an OOM guarantee** against changing load in other processes. They do not raise
  `memory.max` or allocate an artificial Groth16 query cache.

Ping-pong uses the existing two preallocated files; `auto` does not change that
reference path. Passing `ram` with `ping_pong` is rejected. Native callers which
provide their own state to the Rust API own its storage/admission policy; only
the FFI adapter selects RAM or files.

## Correctness and buffer lifetime

Forward layers decode blocks from high indices to low; reversed layers use low
to high. Workers read the old state and write only their disjoint output-block
stripes. Rayon joins all readers before the state is borrowed mutably for
copy-back. Node indices remain global; partial final blocks, special boundary
nodes, parent order and duplicates are preserved. Parent direction is checked
before reading a state whose earlier blocks have already been overwritten.

Parent sources are shared across layers as in the bounded-reader implementation;
a fixed set of worker cursors is allocated once per layer and reused across its
blocks. Rayon task splitting cannot multiply the parent-buffer budget.

The blockwise in-place result resides in the private state, for odd and even layer counts.
The new `zigzag_unseal_range_with_block` API accepts caller-owned state and block
buffers. The existing `zigzag_unseal`/`zigzag_unseal_range` in-place API also
honors blockwise mode; `zigzag_unseal_range_with_scratch` remains an explicit
two-buffer reference. The ordinary FR32 writer remains the default. The optional
[parallel FR32 and streaming output](zigzag-unseal-output.md) adds a separate
writer API which emits the last layer directly and does not retain a complete
padded result. Its final layer omits copy-back; earlier layers use the ordering
above. Existing in-place APIs retain their result-buffer contract.

An error, cancellation or panic can leave earlier blocks of the private state
decoded. The failing block is not copied back; all readers have joined before
their buffers are released. Discard the private state and retry from the original
sealed replica. A caller-supplied cancellation flag is supported by the low-level
block decoder and multilayer entry point. FFI retains its current cancellation
contract; it does not introduce a new external cancellation ABI. Output-writer
failure is propagated, and a retry must use a fresh output or reset it explicitly.

## Reports

`summary.json` records requested `cpu_configuration.decode_state`. `report.json`
and Markdown preserve `zigzag_decode_state` diagnostics: admission, fallback
reason, actual storage, state/block sizes, allocated scratch, per-layer block
counts, decode-plus-join time and copy-back time. The join timer includes worker
computation and the barrier, not exclusive idle time. All timers are nested in
raw unseal and must not be added to its total. Existing phase telemetry retains
observed RAM, CPU, faults and I/O. Parent read statistics remain separate.

## Build and comparison

Devnet pins the committed implementation at Rust revision
`46f7dd618ddfe9cfd11ada83434ac35f7a245990`. The overlay requires
`zigzag_unseal_range_with_block`. Make the commit available in the source
repository, fetch the managed sources and rebuild the selected ZigZag image.
No development-source override is required. An old image cannot exercise the
new mode just by receiving environment variables.

Example after rebuilding, on an available remote machine:

```sh
BENCH_ZIGZAG_DECODE_PARENT_READER=buffered \
BENCH_ZIGZAG_DECODE_MODE=blockwise \
BENCH_ZIGZAG_DECODE_STORAGE=auto \
BENCH_ZIGZAG_DECODE_BLOCK_MIB=64 \
just bench-zigzag-8
```

Keep any explicit parameter/parent-cache directories used by the reference run.
For larger comparisons use the same flags with `bench-zigzag-512` or
`bench-zigzag-32g`. Compare with `BENCH_ZIGZAG_DECODE_MODE=ping_pong` and storage
`auto`/`file`, using the same parent reader. Prefer existing unseal-only fixtures
whose geometry is known, keeping output, cache state, workers and memory limit
identical. Do not infer 32 GiB speedup from an 8 MiB run.

## Validation

- Passed locally: 37 lightweight CPU-setting/report tests and the targeted
  required-API build guard test; shell/JavaScript syntax and Rust parsing.
- Passed locally: seven isolated Rust module tests, compiling the actual
  block scheduling/copy-back and admission/resource-reader modules with cached
  dependencies. They cover ordering, partial blocks, error/cancel/panic before
  copy-back, retry, budget arithmetic and cgroup hierarchy handling. This is not
  a build of the complete PoRep or FFI crates.
- Added full Rust differential tests: each layer in both orientations,
  2/11/17 layers, multiple worker counts, nondivisible blocks and global stripe
  offsets; range/empty-range/writer-failure checks use the public API.
- Added Linux scratch allocation/copy/cleanup coverage and extended the existing
  private-filesystem ENOSPC test to the one-sector fallback.
- Full Rust/FFI compilation and the differential tests remain unexecuted: the
  workspace offline test stops before compilation on missing `dialoguer`.
  No remote build, benchmark or performance acceptance was run for this change.

Targeted checks when the Rust build environment is available:

```sh
FIL_PROOFS_PARENT_CACHE=/tmp/zigzag-blockwise-tests \
  cargo test --locked --no-default-features -p storage-proofs-porep --lib \
  zigzag::vanilla::vde::blockwise
cargo test --locked --no-default-features -p filecoin-proofs --test zigzag_api \
  unseal_full_unaligned_ranges_and_invalid_bounds
```

Repeat the decoder checks with parent cache enabled and disabled. On Linux, run
the existing FFI unseal/retry test in `blockwise` mode with `file` and `ram`
storage. The destructive-space simulation remains ignored by default and must
use the existing isolated small test filesystem, never a shared runtime volume.
