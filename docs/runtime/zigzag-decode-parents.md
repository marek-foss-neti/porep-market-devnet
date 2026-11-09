# ZigZag raw unseal parent readers

The decode path can reuse a validated parent-table source across all layers of
one extraction. Each orientation is opened lazily once. Workers read from that
descriptor; they do not reopen paths or repeat publication locks and validation.
A new extraction checks the current file identity through the existing checksum
cache. Replacing a pathname during an extraction leaves that extraction using its
original validated inode; the next extraction validates the replacement.

This changes only ZigZag decoding. It does not change parent-table contents,
encoding, the KDF, layer count, sector format, SDR, Groth16 or the two sector
buffers. It does not apply encoder DONTNEED advice to shared parent tables.

The optional [blockwise state decoder](zigzag-blockwise-unseal.md) reuses these
readers with one sector state and a bounded output block. Its storage/mode
controls are independent of parent-reader selection; ping-pong remains the default.

## Controls

| Benchmark variable | Native variable | Default / values |
| --- | --- | --- |
| `BENCH_ZIGZAG_DECODE_PARENT_READER` | `FIL_PROOFS_ZIGZAG_DECODE_PARENT_READER` | `legacy`; `legacy`, `buffered`, `mmap` |
| `BENCH_ZIGZAG_DECODE_PARENT_BUFFER_MIB` | `FIL_PROOFS_ZIGZAG_DECODE_PARENT_BUFFER_MIB` | `64`; 1–256 MiB total per active decode |

`BENCH_*` takes precedence. These controls reach both comparison presets and
the existing `bench-proof-micro-unseal` command. Disabling parent cache with
`BENCH_ZIGZAG_USE_PARENT_CACHE=0` selects graph-generated parents regardless of
the requested reader; the actual selection is logged.

- `legacy` keeps the original windowed reader and Rayon initializer path for A/B.
- `buffered` uses positional reads into reusable byte buffers, decodes little-endian
  records, and handles interrupted/short reads and EOF without exposing partially
  filled records. The shared file seek position is never modified.
- `mmap` retains one full read-only mapping per orientation, with no window remaps.
  It owns no parent-record buffers. Mapping 56 GiB is not an allocation of 56 GiB
  RSS, but resident file pages still count toward the container's memory usage.

The new paths allocate a fixed set of cursors before scheduling output stripes.
Their count is bounded by the Rayon pool and available work; a buffered cursor
holds at most 32768 records. Buffer sizes shrink as reader count increases so
their **sum** stays within the configured budget, including on 96/128-thread
machines. Rayon task splitting cannot create extra record buffers. Concurrent
unseals each have their own budget. Sector buffers, small KDF scratch, descriptor
metadata and page cache are additional memory; this setting is not a cgroup cap.

`legacy` remains the default, including in `bench-zigzag-512` and `bench-zigzag-32g`,
until full-sector A/B acceptance. Implementation and correctness tests alone do
not establish which reader wins on the target storage and RAM limit.

## Reports and comparison

`summary.json` records `cpu_configuration.decode` for full ZigZag and unseal-only
runs. `report.json` adds `decode_parent_reads`; Markdown contains the same reader
diagnostics. Open events record source opens, mapping count, elapsed time and
process/publication-lock waits. Layer events record actual reader, orientation,
reader count, owned buffer bytes, positional read calls/bytes and remaps.

Source opening is nested in the first layer using that orientation. Do not sum
these timers with each other or with raw unseal. Positional read bytes are logical
I/O, not physical storage traffic; mmap traffic appears through faults/page cache.
Legacy read/remap counts are unavailable, not zero. Use the existing phase
telemetry for CPU user/system time, RAM, faults and pressure.

Devnet pins the committed implementation at Rust revision
`bd1fb47b4ea7ac82ecb052e66ebbbd285cec60a3`. Fetch the managed sources and rebuild
the ZigZag images: the FFI overlay uses the new Rust `DecodeConfig` API. An old
image cannot exercise the new reader just by receiving its environment variables.

For a full 512 MiB comparison on a free remote machine:

```sh
BENCH_ZIGZAG_DECODE_PARENT_READER=buffered just bench-zigzag-512
```

Repeat with `mmap` and `legacy`. Prefer the existing unseal-only command when a
valid prepared fixture is available, with identical geometry, parent tables,
output, workers, memory budget and cache state for each candidate. No new sealing
or parameter prewarm is needed for such a fixture. Promote a default only after
the 32 GiB / 17-layer comparison at the agreed total memory limit of 120 GiB.

## Validation status

- Passed locally: 35 lightweight configuration/report tests, shell syntax,
  Rust syntax parsing via rustfmt, and whitespace checks.
- Added Rust tests: both parent orientations and special nodes, random/tail
  reads, bounded layouts up to 4096 threads, shared descriptor position,
  interrupted/short reads and EOF, failed-refill retry, replacement/revalidation,
  and multilayer decode for 2/11/17 layers with different worker counts.
- Rust tests are **not yet compiled or run**: the offline attempt stopped on
  missing `dialoguer` in workspace dependency resolution before compilation.
- No benchmark, full image build or measured speedup is claimed. A remote
  machine was unavailable; further remote testing was deferred by the user.

Targeted Rust tests to run when the build environment is available:

```sh
FIL_PROOFS_PARENT_CACHE=/tmp/zigzag-decode-reader-tests \
  cargo test --locked --no-default-features -p storage-proofs-porep --lib \
  zigzag::vanilla::decode_parents::tests
FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=1 \
FIL_PROOFS_PARENT_CACHE=/tmp/zigzag-decode-reader-tests \
  cargo test --locked --no-default-features -p storage-proofs-porep --lib \
  zigzag::vanilla::vde::tests::decode_readers_preserve_layers_orientations_and_worker_counts
```
