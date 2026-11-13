# ZigZag FR32 and final-layer output

This optional raw-unseal path converts each 128-byte padded group into 127 raw
bytes with fixed shifts and masks. Rayon converts disjoint groups into one
reusable output batch; the calling thread writes it in order. It changes only
ZigZag. SDR's FR32 implementation, sealed format, KDF and proof geometry are
unchanged.

## Controls and actual execution

| Benchmark variable | Native variable | Default / values |
| --- | --- | --- |
| `BENCH_ZIGZAG_UNSEAL_OUTPUT` | `FIL_PROOFS_ZIGZAG_UNSEAL_OUTPUT` | Benchmark: `stream`; native: `reference`; values: `reference`, `parallel`, `stream` |
| `BENCH_ZIGZAG_UNSEAL_OUTPUT_CHUNK_MIB` | `FIL_PROOFS_ZIGZAG_UNSEAL_OUTPUT_CHUNK_MIB` | `64`; 1–64 MiB of padded input per batch |

`BENCH_*` overrides the native setting in dedicated full and unseal-only
benchmarks. Parent-reader, decode mode and storage controls remain independent.
The [benchmark preset](zigzag-benchmarks.md#shared-raw-unseal-defaults) selects
`stream`; native Rust/Curio defaults stay `reference`, which does not allocate
the new buffer.

| Mode | Decode | Output |
| --- | --- | --- |
| `reference` | All layers in full, with the selected ping-pong/blockwise decoder | Existing `fr32::write_unpadded` |
| `parallel` | Same complete decode as reference | Bounded parallel FR32 followed by ordered writes |
| `stream` | Intermediate layers in full; only the requested groups of the final layer | Decode a chunk, parallel FR32, ordered write, then reuse buffers |

In `stream`, the final layer reads immutable state. Both graph orientations
therefore emit ascending offsets without final copy-back or materializing a
complete final padded result. Earlier layers retain the selected decoder's
ordering and barriers. Ping-pong still needs two sector buffers for intermediate
layers; streaming does not reduce that reservation to one sector. Blockwise
continues to need one sector plus its reusable block.

The new Rust API is `zigzag_unseal_range_streaming`. Its state/scratch buffers
are disposable and do not promise a complete padded result. Existing in-place
APIs preserve their contracts: requesting `stream` through those APIs uses
parallel FR32 after full decoding, and logs actual mode `parallel`. The dedicated
FFI adapter, full microbench and unseal-only runner call the streaming API when
requested. A configured mode alone is not proof that an old image uses it.

## Memory, workers and writers

There is one reusable raw buffer, at most `chunk_bytes / 128 * 127` bytes, capped
by the requested padded range (and, in streaming mode, available scratch).
At the default 64 MiB,
this is at most **63.5 MiB per call**, not per worker. The same Rayon pool serves
decode and conversion; the arbitrary `Write` stays on the calling thread and
does not need `Send` or `Sync`.

All workers finish before the writer runs. There is one output batch in flight
and no growing producer queue: a slow writer stops production of the next batch.
RAM admission in the FFI blockwise adapter includes the additional raw buffer;
file pages and other existing reserves remain part of its accounting.

The output chunk also caps final-layer decode work. With the existing minimum
stripe of 16,384 nodes, 64 MiB allows up to 128 decode stripes, whereas 4 MiB
allows only eight. Actual concurrency also depends on the Rayon pool, parent
buffer budget, range and scratch size. A smaller output buffer is not necessarily
faster on many-core hosts; tune it using full raw unseal, not FR32 alone.

Public offsets/counts are unpadded. Nonempty `[u,u+n)` maps to padded groups from
`128 * floor(u/127)` to `128 * ceil((u+n)/127)`, then trims the first/last output.
Arithmetic and bounds are checked; a valid empty range returns before scratch
allocation or decode. Partial writes and `Interrupted` are handled, `WriteZero`
and other errors propagate, and cancellation is checked between chunks/writes.
A blocking system write itself cannot be interrupted by the Rust cancellation
flag. FFI has no new cancellation ABI.

On error or panic, discard private state and reset/replace the destination before
retrying from sealed input. No automatic retry appends to a partially written
pipe or other arbitrary writer. The sealed replica remains untouched. Pipe
output through FFI requires an explicit writable scratch directory because a
pipe has no output-directory path; file scratch remains physically preallocated.

## Reports

`cpu_configuration.unseal_output` records requested settings. `report.json`
retains `zigzag_unseal_output` events with actual mode, completed status, written
bytes, output-buffer size, batch count, FR32 time and writer time. Markdown
renders these separately. `zigzag_decode_state` records final-layer decoded bytes,
decode-plus-join time and zero final copy-back in streaming mode.

FR32 time includes parallel work and joining; writer time includes calls,
backpressure and any inline sink verification. It is not exclusive disk wait.
Reference FR32 time is the total reference output call minus timed writes.
These are nested diagnostics: **do not add them to full raw-unseal wall time**.
Raw unseal still returns and verifies unpadded bytes and includes preparation,
all required layers and output; it is not replaced with a padded-only timer.

## Build and comparison

Devnet pins the committed implementation at Rust revision
`1382a85216f15324b1b1cd140c78e375035783c8`. The FFI overlay requires
`zigzag_unseal_range_streaming` and the output configuration API. Make this
commit available in the source repository, fetch the managed sources and
rebuild the dedicated ZigZag image. No development-source override is required.
The repin does not establish full Rust/FFI validation or a measured speedup.

For an existing 512 MiB / 17-layer fixture, compare the following three values
of `BENCH_ZIGZAG_UNSEAL_OUTPUT`: `reference`, `parallel`, then `stream`. Keep all
other settings and cache conditions identical. Example for streaming:

```sh
POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
BENCH_PROOF_MICRO_PROFILE= \
BENCH_PROOF_MICRO_LAYERS=17 \
BENCH_ZIGZAG_FULL_MEMORY_BYTES=8589934592 \
BENCH_ZIGZAG_QUERY_CACHE_BYTES=0 \
BENCH_ZIGZAG_DECODE_PARENT_READER=buffered \
BENCH_ZIGZAG_DECODE_PARENT_BUFFER_MIB=64 \
BENCH_ZIGZAG_DECODE_MODE=blockwise \
BENCH_ZIGZAG_DECODE_STORAGE=auto \
BENCH_ZIGZAG_DECODE_BLOCK_MIB=64 \
BENCH_ZIGZAG_UNSEAL_OUTPUT=stream \
BENCH_ZIGZAG_UNSEAL_OUTPUT_CHUNK_MIB=64 \
BENCH_PRUNE_BUILDKIT_AFTER_BENCH=0 \
just bench-proof-micro-unseal zigzag 512mib \
  "$PWD/.runtime/proof-micro-fixtures/zigzag-512mib-17layers"
```

Use the actual fixture path/geometry. Repeat with ping-pong separately, keeping
the decode mode fixed within each three-way comparison. Unseal-only does not
generate Groth16 parameters. No benchmark has been run for this implementation.

## Validation — 9 November 2026

- Passed: five isolated tests of the actual new Rust output module against the
  existing `fr32/src/padding.rs`, using cached dependencies. Coverage includes
  all 1,024 individual bits of a group, padding bits, 2 MiB patterned input,
  full/ranged output, 0/1 B, 1 KiB/1 MiB, offsets 126/127/128/129, one/four workers,
  buffer reuse, ordering, short writes, `Interrupted`, zero progress, errors,
  cancellation, panics and retry with a new destination.
- Passed: 38 lightweight CPU-setting/measurement/report tests and the targeted
  required-API guard test. These validate configuration forwarding and nested
  timing semantics; they do not build PoRep/FFI.
- Added, not yet run: PoRep differential tests for both graph orientations,
  2/11/17 layers, both decode modes, multiple stripes/global offsets, sink
  failures and public unpadded ranges; an FFI pipe/scratch/descriptor test extends
  the existing ignored test.
- The full Rust offline workspace test stops before compilation because
  `dialoguer` is missing from the local dependency cache. Full Rust/FFI build,
  differential integration tests and performance acceptance remain outstanding.
  No local benchmark, prewarm or remote test was launched.

Targeted checks on an available build/test machine after repin/rebuild:

```sh
cargo test --locked --no-default-features -p filecoin-proofs --lib \
  api::zigzag::unseal_output
cargo test --locked --no-default-features -p storage-proofs-porep --lib \
  zigzag::vanilla::vde::blockwise
cargo test --locked --no-default-features -p filecoin-proofs --test zigzag_api \
  unseal_full_unaligned_ranges_and_invalid_bounds
```

Run the integration tests under each output mode and parent-reader mode with an
isolated parent-cache directory. On Linux, also run the existing ignored FFI
unseal test with `stream` and both `ping_pong`/`blockwise`, using file and admitted
RAM storage as applicable. Do not infer a 32 GiB speedup from these small checks.
