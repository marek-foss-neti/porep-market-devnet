# ZigZag layer snapshots and CPU overlap

The shared ZigZag `replicate_layers` implementation now supports two independent
pipeline variants. Ordinary and split PC1 in the dedicated FFI/Curio adapter
use the same code. SDR, TreeD, KDF, graph traversal, commitments, circuit and
Groth16 parameters are unchanged.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BENCH_ZIGZAG_TREE_R_BUILDER` | `legacy` | Select `binary` for either pipeline variant. |
| `BENCH_ZIGZAG_LAYER_PIPELINE` | `sequential` | `sequential`, `overlap`, or `stream`. |
| `BENCH_ZIGZAG_TREE_R_THREADS` | `auto` | Tree pool threads, 1–64, clipped to the effective Rayon count minus encoder/feeder threads, with a minimum of one. |
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

Both pipeline variants limit unsynchronized builder writes to 64 MiB per
store. Writes and periodic `sync_data` are serialized at that threshold; final
file and directory sync remain mandatory. With a current snapshot and an older
tree, at most two such stores write concurrently. This bounds these stores'
dirty data, not the active replica, clean page cache or total cgroup memory.
The existing synchronized TreeR DONTNEED advice still applies after publication.

The tree pool is created before encoder affinity binds the calling thread.
The requested count is clipped to leave scheduling capacity for the encoder
and feeders. This is a thread bound, not an exclusive CPU reservation; small
cpusets and other sectors/services can still contend. Builder vectors retain
their previous maximum of 40 MiB, independently of the snapshot pool.

JSON/Markdown reports preserve requested configuration, effective tree threads,
buffer counts/bytes, orientation, written chunks and capture readiness.
`tree_r_snapshot`, `tree_r_build`, `tree_r_sync` and `tree_r_backpressure` remain
suboperations inside PC1. In stream mode, `tree_r` includes capture during
encoding; the `encode` interval also includes writer startup/preallocation and
buffer backpressure. Overlapping operation CPU/RAM covers the whole process
and must not be summed. `capture_ready_ms` includes preallocation, encode,
capture and relevant waits; it is not an additional phase. Total sealing still
sums only the main phases.

## Integration and acceptance

The pipeline implementation is committed and pinned in `versions.lock.yaml` at
`38c1803db561c7c94369b358813d0019b33484e6`. Fetch the managed sources and rebuild
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
benchmarks or an automatically scheduled matrix. Keep the 60 GiB comparison
budget and account for other services. Pipeline modes also introduce bounded
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
