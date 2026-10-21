# ZigZag layer snapshots and CPU overlap

The shared ZigZag `replicate_layers` implementation now supports two independent
pipeline variants. Ordinary and split PC1 in the dedicated FFI/Curio adapter
use the same code. SDR, TreeD, KDF, graph traversal, commitments, circuit and
Groth16 parameters are unchanged.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BENCH_ZIGZAG_TREE_R_BUILDER` | `legacy` | Select `binary` for either pipeline variant. |
| `BENCH_ZIGZAG_LAYER_PIPELINE` | `sequential` | `sequential`, `overlap`, or `stream`. |
| `BENCH_ZIGZAG_TREE_R_THREADS` | `auto` | Tree pool threads, 1–128, clipped to the effective Rayon count minus encoder/feeder threads, with a minimum of one. |
| `BENCH_ZIGZAG_SNAPSHOT_BUFFER_MIB` | `64` | Streaming pool capacity, 1–64 MiB; small sectors allocate only the required buffers. |

For Rust and dedicated Curio, replace `BENCH_ZIGZAG_` with
`FIL_PROOFS_ZIGZAG_`. Both adapters forward the settings explicitly. Empty or
invalid values fail. A nonsequential pipeline requires the binary builder,
Linux and the exact binary Poseidon DiskStore shape; it does not silently fall
back. The current default remains `legacy` + `sequential` until full comparable
performance acceptance. Thread and buffer overrides affect the pipeline modes.

## Ownership and execution

`overlap` encodes layer L, waits for the older tree if needed, physically
preallocates TreeR(L), copies its leaves, and starts internal-node construction
on a private Rayon pool. Encode(L+1) can run while that tree builds. There is
at most one unfinished older tree, and snapshot L+1 waits for it.

`stream` preallocates TreeR(L) before encoding and starts one leaf writer.
The encoder copies completed ranges into owned 1 MiB buffers. Each message
contains the layer, absolute offset, length and buffer. The pool is recycled
only after a complete positioned write. Exhausting it blocks the encoder
instead of allocating more buffers. For reverse layers, chunk offsets descend
but bytes within each chunk retain increasing file-address order. The writer
validates orientation, offsets, lengths, layer and complete coverage.

The states are **encoded → captured → written → durable**. A callback borrows
replica bytes synchronously; the background writer receives only a copy. This
implementation joins the leaf writer before starting that layer's hash build
and before encoding the next layer. A builder therefore reads only a complete
immutable snapshot. While streaming L, TreeR(L−1) may still build: at most one
tree builds and one captures. The older builder is joined before starting a
new builder. Roots are collected in layer order, and CommRStar is computed
only after all trees finish.

Each background task has cancellation and a mandatory join on error, panic or
early return. Cancellation also reaches the existing encoder/feeder pipeline.
Incomplete private snapshots are removed. Finished stores retain the builder's
file/directory sync and no-overwrite publication. FFI retains its existing
private-generation lock, cleanup, original input for retry and AUX-last
publication. No extra historical layer file is created beside TreeR leaves.

## Resources and measurements

Both pipeline variants keep a 64 MiB outstanding-write window per active store.
Reservations count before positioned writes begin; completed writes remain
charged until a background `sync_data` finishes. The worker starts flushing at
32 MiB, or sooner when a writer cannot reserve its next chunk. Hash workers and
the snapshot writer can use the remaining credits during that flush. No mutex
is held across writes or flushes. A flush retires only writes completed before
it started; concurrent completions stay charged for a later flush. Thus moving
I/O into the background does not create an unlimited dirty-write queue.

There is one flush worker per active store. In the bounded builder it replaces
the advisory writeback thread; streaming additionally has its leaf writer and
the current snapshot's flush worker. At most two stores write concurrently.
The last partial window is flushed and every worker is joined before returning,
including on I/O error, cancellation or panic. Final file and directory sync
remain mandatory. This is a conservative bound on outstanding write bytes,
not an exact measurement of dirty OS pages, the active replica, clean page cache
or total cgroup memory. The sequential binary reference retains its existing
advisory writeback path. This refinement does not change the next-layer barrier:
the snapshot writer is still joined before starting the next encode.
TreeR DONTNEED is deferred until C2 entry, after all C1 work and validation.
Publication keeps its durability syncs without discarding pages needed by C1;
see [cache policy](zigzag-cpu-tuning.md#bounded-records-and-advice).

The tree pool is created before encoder affinity binds the calling thread.
The requested count is clipped to leave scheduling capacity for the encoder
and feeders. This is a thread bound, not an exclusive CPU reservation; small
cpusets and other sectors/services can still contend. Builder vectors use at
most 80 MiB at 128 workers, independently of the unchanged 64 MiB snapshot pool.
With the default two feeders and one encoder, `auto` selects
`max(1, min(128, Rayon threads - 3))`: 29 workers on 32 available threads,
93 on 96, 125 on 128, and 128 on 256. Explicit requests are also clipped to
that ceiling. Small trees additionally use no more hash workers than there
are first-level chunks. These counts are selected at startup/per call, not
dynamically retuned according to load from other host processes.

JSON/Markdown reports preserve requested configuration, effective tree threads,
buffer counts/bytes, orientation, written chunks and capture readiness.
`tree_r_snapshot`, `tree_r_build`, `tree_r_sync` and `tree_r_backpressure` remain
suboperations inside PC1. In stream mode, `tree_r` includes capture during
encoding; the `encode` interval also includes writer startup/preallocation and
buffer backpressure. Overlapping operation CPU/RAM covers the whole process
and must not be summed. `capture_ready_ms` includes preallocation, encode,
capture and relevant waits; it is not an additional phase. Total sealing still
sums only the main phases.

Completed snapshot records additionally report `writer_input_wait`,
`writer_write_ns` and `dirty_budget`. The encoder's joined-writer record reports
`snapshot_buffer_wait` and `writer_finish_wait_ns`. Each wait has `events` and
`elapsed_ns`; an event is one observed wait episode, not a polling iteration.
Clocks for queue waits start only when no item/buffer is immediately available.
`dirty_budget` records limit/flush threshold, peak outstanding credits, retired
bytes, flush count/time and summed writer `budget_wait`. The same object is
reported in TreeR builder `stats`. Budget waits are already included in
`write_ns`/`writer_write_ns`; background flush time overlaps writes and hashing.
JSON preserves the records and Markdown has separate wait/writeback tables.
These intervals must not be added to PC1 or interpreted as exclusive CPU time.
Older reports without the fields have unavailable measurements, not zero waits.

The refinement is wired into shared ZigZag PC1, including FFI/Curio; it does not
alter SDR, commitments, parameters, memory presets or feature defaults. It is
included in the pinned Rust revision; fetch the managed sources and rebuild
the dedicated images to use it.

## Validation — 15 October 2026: background writeback and wait metrics

The final remote source-content SHA-256 is
`bcf3356dd0f167d1bd4d46c39909b2d0e002ba7c5d5df3473d73976bd1f9f20c`,
based on Rust commit `1977b4edce2c27c019a3c302c595ad1adee59753` plus
uncommitted changes at validation time. These sources are now committed as
`bcb7d508f995b2ccec94e4473c156cb92d17a775`; the digest matches that revision
and both built images.

- 62 remote Rust tests passed: six writeback, eight builder, six pipeline,
  40 vanilla/encoder and two prehash tests. Two optional large-store/ENOSPC
  builder fixtures remained ignored. New tests cover progress during a blocked
  flush, retaining credits for concurrent and in-flight writes, strict bounds,
  final partial-window flushing, cancellation, I/O errors and worker panics.
- Four full 2 KiB cycles passed Groth16 verification and byte-identical unseal:
  legacy/no-prehash reference, and binary/prehash with sequential, overlap and
  stream. Every persisted replica/tree file matched the reference. Actual JSON
  and Markdown contained the new wait records and bounded-writeback counters;
  every dirty window respected its limit and retired all written bytes.
- Both dedicated microbench and Curio images built. Curio and sptool startup
  passed. Rust tests used 8 GiB/four CPUs and full fixtures 12 GiB/four CPUs,
  with no additional swap. Heavy work ran remotely and sequentially.
- 30 lightweight report/configuration tests passed locally, together with Rust
  formatting, JavaScript syntax and diff whitespace checks.

[Validation evidence and JSON/Markdown reports](../../.runtime/remote-runs/fidl-lab/2026-10-15-cpu-writeback-validation/validation.json)
establish correctness, not a PC1 speedup. No new 512 MiB/32 GiB performance run
was started. Compare the existing full benchmark at identical settings before
changing feature defaults or claiming a time saving. The main remote checkout
and its image manifests were left unchanged; builds used an isolated copy.

## Integration and acceptance

The pipeline implementation, including background writeback and wait metrics,
is committed and pinned in `versions.lock.yaml` at
`b1cec2213b8132adc6164ccb5a289c35e279eadf`. Fetch the managed sources and rebuild
both dedicated images to use this revision. Dedicated builds require
`LayerPipelineConfig`; no development-source override is needed for this pin.
For further uncommitted development, use an isolated copy inside the devnet
context via `DEVNET_RUST_FIL_PROOFS_SOURCE`. Never edit managed source checkouts,
stage files or create commits automatically.

Run heavy checks only on the remote machine and sequentially. Compare fresh
full runs with identical memory, CPU, allocator and cache controls:

```sh
BENCH_ZIGZAG_TREE_R_BUILDER=binary BENCH_ZIGZAG_LAYER_PIPELINE=sequential just bench-zigzag-512
BENCH_ZIGZAG_TREE_R_BUILDER=binary BENCH_ZIGZAG_LAYER_PIPELINE=overlap just bench-zigzag-512
BENCH_ZIGZAG_TREE_R_BUILDER=binary BENCH_ZIGZAG_LAYER_PIPELINE=stream just bench-zigzag-512
```

These are explicit variants of the existing full benchmark, not new phase-only
benchmarks or an automatically scheduled matrix. Keep the same RAM limit for
all variants (currently 50 GiB base plus any requested query cache) and account for other services.
Pipeline modes also introduce bounded
dirty writes, so their difference from sequential includes that I/O policy.
Compare full PC1, later C1 reads and total sealing, not summed nested timers.
Correctness tests alone do not establish a speedup.

## Validation — 14 October 2026

The remote build uses Rust source content SHA-256
`232b5fb624f469db233d61f746d38756adedd948302a59f7fb28ad6fe32bd548`.
This identifies the working sources, not an additional Git commit.

- 52 targeted Rust tests passed: 6 pipeline, 9 builder and 37 vanilla tests.
  They cover all layer-store bytes/roots, both traversal directions, odd/even
  layer counts, vanilla proofs, a slow writer with one buffer, invalid ordering,
  injected ENOSPC/panic, cleanup/retry, cancellation and dirty-budget flush errors.
  The large-store, physical-ENOSPC and live-affinity fixtures were not rerun.
- The ordinary/split FFI regression test passed separately with `overlap` and
  `stream`, including C1, unseal and retry. Both modes also passed complete 2 KiB
  sealing with Groth16 verification and byte-identical unseal, in 12 GiB
  containers with equal memory/swap limits and four CPUs.
- Dedicated microbench and Curio images built successfully from those sources;
  Curio and sptool startup/version checks passed. This is not a full Curio
  service lifecycle or a 32 GiB acceptance run.
- 28 settings/report mock tests, the required-API guard test, TypeScript
  typecheck, shell syntax and Rust formatting checks passed locally. No Rust
  build, proof fixture or benchmark ran locally.

Small full-run summaries and image manifests are saved in
[the validation folder](../../.runtime/remote-runs/fidl-lab/2026-10-14-layer-pipeline-validation/).
At the **13:31 UTC checkpoint**, the full 512 MiB `binary + stream` run had
completed PC1 in **256,031 ms**, captured/built all 11 layers and reached C1.
The sampled PC1 cgroup peak was **4,216,434,688 B (3.93 GiB)**; its cumulative
kernel peak was **4,264,427,520 B (3.97 GiB)**, with no OOM or limit events.
The run uses the unchanged 60 GiB preset, fresh parent tables and reused Groth16
parameters. [The interim record](../../.runtime/remote-runs/fidl-lab/2026-10-14-layer-pipeline-validation/bench512-progress.json)
is explicitly incomplete: final 512 MiB Groth16 verification/unseal were still
pending at that checkpoint. Performance acceptance remains pending; no speedup
is claimed from these checks.
