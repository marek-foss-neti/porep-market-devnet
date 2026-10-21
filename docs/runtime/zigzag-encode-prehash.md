# ZigZag SHA preparation in encode feeders

The existing encode feeders can prepare a SHA-256 midstate for each node before
the sequential consumer encodes it. Ordinary and split PC1 in dedicated
FFI/Curio and the full microbenchmark use the same Rust implementation. No SDR
code, SHA feature, graph, parent order, KDF, commitment, circuit or parameter
identity changes. This adapts SDR's division of SHA work between producers and
consumer, using the public incremental `sha2::Sha256` API for ZigZag's message.

| Setting | General runner / native default | Meaning |
| --- | --- | --- |
| `BENCH_ZIGZAG_ENCODE_PREHASH` | `0` | Prepare stable SHA prefixes in encode feeders. |
| `FIL_PROOFS_ZIGZAG_ENCODE_PREHASH` | `0` | Equivalent Rust and dedicated Curio control. |

The general runner accepts the native variable; a `BENCH_` override wins.
`just bench-zigzag-512` and `just bench-zigzag-32g` explicitly enable prehash
in their shared comparison preset; use `BENCH_ZIGZAG_ENCODE_PREHASH=0` to disable
it for a comparison. Empty and invalid values fail. Multicore encoding must be
enabled for prehashing to do work. It works with legacy/binary TreeR and
sequential/overlap/stream layer pipelines; it does not require another
experimental option. The general runner and native defaults remain off.
Producer count remains two.

## Message and ownership

A feeder loads the completed-node frontier with Acquire and copies only parent
values preceding that frontier. Those nodes remain immutable for the current
layer. It hashes the contiguous prefix `replica_id || parents`, stopping before
the first missing parent and rounding down to whole 64-byte SHA blocks. Later
ready parents may still be copied into the existing slot, but cannot be hashed
through a hole. Repeated parents retain all occurrences in graph order.

The slot owns the incremental state and processed byte count. The existing
Release/Acquire ring publication transfers exclusive access to the consumer.
The consumer fills missing values, takes the state, appends the remaining
bytes and finalizes once. The hasher retains the true total length and applies
the original padding. A 480-byte message can move up to seven data-block
compressions to a feeder; padding and the remaining suffix stay on the
consumer. A prefix shorter than one block, including the first node's ID-only
message, uses the unchanged whole-message digest. Field masking is unchanged.

Reverse traversal uses traversal positions to determine readiness and preserves
the graph's parent order. Every slot is reset before reuse. No producer mutates
a published state, no state crosses a layer boundary, and existing cancellation,
panic handling, failed-spawn cleanup and joined worker lifetimes remain intact.

## Memory and reports

There is one optional inline SHA state per ring slot, with no per-node heap
allocation or sector-sized state table. Its storage is reserved in the slot
even when the option is disabled. Actual `size_of` and total ring state bytes
are reported; existing parent/input vectors and allocator overhead are separate.

Feeders accumulate small local histograms and combine them after joining. One
`zigzag_encode_prehash` JSON record is emitted per successful multicore encode
call, with orientation, node count, blocks prepared and histogram bins indexed
by prepared data-block count. There are no per-node log messages or shared
statistics atomics. Wait clocks run only when a loop observes contention, not
on every node or poll. Interrupted calls do not emit a successful summary.
Records are preserved in `report.json` under `encode_prehash` and in the Markdown
phase report. They describe work distribution, not a speedup or another phase.
Configuration is also recorded in microbench output and provenance.

Each successful record now includes `consumer_ready_wait` and a `feeders`
array indexed by `producer`. Each feeder records `ring_full_wait` (cannot reuse
a slot until the consumer advances) and `publication_wait` (an earlier stride
must publish first), as well as its prefix histogram. Wait values contain
`events` and `elapsed_ns`. Accumulation is thread-local and collected after
joining. These are elapsed wait intervals including scheduling, not exclusive
CPU time or a count of yields. They work with prehash both on and off.

The full report renders these waits beside snapshot-buffer starvation, writer
input waits and bounded-writeback metrics. They can distinguish consumer
starvation from full-ring backpressure or ordered-publication blocking; the
histogram alone cannot. Waits across threads overlap, and feeder backpressure
may originate in a slow snapshot writer. Do not sum them into encode/PC1 or
assume they prove spare feeder CPU capacity. Two feeders remain the default;
three/four already work through the existing producer setting. Tune that
setting, stride and lookahead only after comparing the complete PC1 workload.

## Integration and acceptance

The prehash implementation and encoder wait metrics are committed and pinned at
`d4c6c3e8124fe7b64730246297910adfa1606ab4`, the
[combined CPU/GPU revision](zigzag-gpu-groth16.md#cpu-updates-and-dependency-pin).
Fetch the managed sources and rebuild both dedicated images on the remote
machine. Both build guards require `EncodePrehash`; this pin needs no
development-source override. For further uncommitted changes, select an
isolated copy of the complete Rust source inside the devnet context with
`DEVNET_RUST_FIL_PROOFS_SOURCE`. Never modify managed
checkouts, stage changes or create commits automatically.

Use the existing full benchmark on the remote machine, with identical memory,
CPU, allocator, cache and layer-pipeline settings:

```sh
BENCH_ZIGZAG_ENCODE_PREHASH=0 just bench-zigzag-512
BENCH_ZIGZAG_ENCODE_PREHASH=1 just bench-zigzag-512
```

These are explicit comparison runs, not an automatic benchmark matrix. Keep
the current 50 GiB base preset plus query cache (10 GiB by default) and no extra container swap; start only when the shared host
has enough headroom for its other services. Compare encode, full PC1 and total
sealing. A histogram with many prepared blocks alone does not establish a
benefit: feeders and the consumer still contend for CPU/cache bandwidth.
Do not change producer count without evidence of consumer starvation.

The wait-metric refinement was validated before its commit on 15 October 2026 together
with background writeback: 62 remote Rust tests, four full 2 KiB cycles with
identical replica/tree bytes and valid proof/unseal, both dedicated image builds
and 30 lightweight report/configuration tests. Actual records were checked with
prehash both off and on. See the [writeback validation](zigzag-layer-pipeline.md#validation--15-october-2026-background-writeback-and-wait-metrics)
for the source digest and evidence. No new 512 MiB performance claim follows
from these small correctness runs. The current Rust pin includes the refinement;
normal builds use it after fetching the managed sources and rebuilding.


## Validation — 14 October 2026

The remote build tested source-content SHA-256
`48a5eabf75abbd8b50769183e0130e47bb67884248997c5192953409a123f3b3`,
on top of Rust commit `5fc76924a65213c73bf65b8c0c82bc7c6f394297`.

- 48 Rust tests passed: 40 vanilla/graph/encoder, two prehash and six layer
  pipeline tests. Coverage includes every 14-parent missing mask, all SHA prefix
  byte boundaries, both orientations, duplicate parents, ring shapes,
  one to four feeders, cached/uncached/buffered parents, sink cancellation,
  producer errors/panics and spawn failures. The existing live-affinity test
  remained ignored.
- Ordinary/split FFI PC1, C1, unseal and retry passed with prehash enabled for
  each of the sequential, overlap and stream modes.
- Four full 2 KiB runs passed Groth16 verification and byte-identical unseal:
  reference legacy/no-prehash, and binary/prehash with all three pipeline modes.
  All persisted replica/TreeD/TreeR bytes matched the reference. Lookahead 4 and
  stride 1 made the optimized path execute: feeders processed 630–634 SHA data
  blocks across each full run. These counts are not a speedup measurement.
- Both dedicated images built successfully; Curio and sptool startup passed.
  Test containers used 8 GiB and full-run containers 12 GiB, four CPUs each,
  with no extra swap. All fixtures and builds ran remotely and sequentially.
- 29 local settings/report tests, one required-API guard, TypeScript typecheck,
  shell syntax and Rust formatting passed. No local Rust build or benchmark ran.

The measured midstate slot size on the tested x86_64 build is 128 bytes: 512 KiB
at the default lookahead 4096, also reserved when prehash is off. Complete
[evidence and small-run summaries](../../.runtime/remote-runs/fidl-lab/2026-10-14-encode-prehash-validation/)
record image identities and file hashes. Full 512 MiB/32 GiB performance and
Curio service lifecycle acceptance remain pending. The shared host's available
memory changed substantially during validation, so no large comparison was
started; the option remains off by default.
