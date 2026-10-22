# Bounded binary CPU TreeR construction

The ZigZag implementation in `storage-proofs-porep/src/zigzag/merkle_builder.rs`
builds the existing full binary Poseidon DiskStore. It is called by the shared
ZigZag `replicate_layers` path used by ordinary PC1, split PC1, dedicated FFI,
Curio and the full microbenchmark. TreeD construction, SDR, the shared Merkle
builder, circuit, parameters and commitments retain their existing contracts.

## File and execution contract

For N leaves the store contains `2N - 1` canonical 32-byte field elements:
unchanged leaves, successive parent levels, then the root. Only the exact
binary Poseidon DiskStore shape uses the specialized implementation. Other
shapes, in-memory requests and non-Linux platforms use the shared builder and
report the fallback reason. There is no arity conversion or additional leaf
hash. The U2 Poseidon constants, strength, domain and left/right ordering are
identical to the existing public `node` and `multi_node` methods.

Construction has three explicit ownership boundaries:

1. **Snapshot:** create a private file in the cache directory, physically
   allocate the full store with Linux `fallocate`, and copy the leaves in
   bounded chunks. Neither sparse `set_len` nor reflink copies are used.
2. **Internal nodes:** read complete child levels, convert each chunk to
   `[Scalar; 2]` pairs, reuse the Poseidon state within each chunk and write
   parent bytes at their original offsets. A Rayon barrier separates levels.
3. **Publication:** sync the complete file, publish without overwriting an
   existing StoreConfig file, sync the directory, reopen through the existing
   DiskStore/MerkleTree APIs, and check the root and exact file length.

Completed ranges request Linux writeback while the CPU builds later levels.
This uses only `SYNC_FILE_RANGE_WRITE`, may block on a full I/O queue, and never
replaces the final file/directory sync. It is an I/O scheduling hint, not proof
of durability ([Linux manual](https://man7.org/linux/man-pages/man2/sync_file_range.2.html)).
An unsupported hint falls back to final sync; other I/O errors fail the build.
One scoped I/O thread receives completed ranges through a one-entry queue.
It is joined on success, error and cancellation before file cleanup/publication.

The leaf snapshot is independent of later writes to the replica. This is the
boundary used by the optional [layer pipeline](zigzag-layer-pipeline.md).
Sequential mode completes each TreeR before starting the next encode; pipeline
modes overlap immutable tree work with encoding. Neither creates an extra
historical sector copy beside the leaves already retained in each TreeR.

Positioned reads/writes avoid writable mmap in the specialized builder.
Short transfers and EINTR are handled explicitly; ENOSPC, invalid field bytes
and I/O failures return errors. A worker failure cancels new work and joins
all workers before cleanup. A cancelled or failed private build is not
published. An existing final store is rejected rather than assumed complete.
An abrupt process kill can leave private temporary files; the existing FFI
precommit workspace recovery remains responsible for abandoned generations.

## Bounded resources and measurements

Each worker owns three reusable vectors: input bytes, fixed-size field pairs
and output bytes. There are at most 4096 pairs per chunk and
`min(Rayon threads, 128, first-level chunks)` workers. The maximum vector
capacity is 80 MiB; with 24 workers it is 15 MiB. Buffers survive level barriers.
The limit is shared with the overlap/stream pool. Sequential binary construction
uses the calling Rayon pool without reserving encoder threads, since encoding
and tree construction do not overlap. `BENCH_ZIGZAG_TREE_R_THREADS` controls the
overlap/stream pool only; use `BENCH_RAYON_NUM_THREADS` to bound sequential work.
There is no sector-sized node vector or vector of all chunk tasks.

These limits cover builder-owned buffers, not the replica, OS page cache,
shared Poseidon constants, Rayon or other sealing allocations. The existing
benchmark cgroup caps the whole workload at 50 GiB base plus any requested query cache. TreeR DONTNEED runs only at C2 entry,
after C1 validation, rather than after individual tree builds; builder syncs
still guarantee durability.
No additional Groth16 query retention is enabled.

The existing full benchmark records `tree_r_snapshot`, `tree_r_build` and
`tree_r_sync` operation intervals inside each layer's `tree_r` interval.
`zigzag_merkle` records add the actual builder, worker count, vector allocation
count/capacity, processed pairs, bytes read/written and summed worker times for
read, conversion, hash/serialization and write. These are exported to
`report.json` as `tree_r_builds` and to `summary.md`.
`writeback_submit_ns` separately measures the I/O thread submitting leaves and
completed internal levels during the build interval. It overlaps hashing and
is not a measurement of device completion time.

Worker timers overlap. Operation CPU/RAM still measures the whole process
during that interval. Neither worker times nor nested operation intervals may
be added to total PC1 or sealing time. Vector counters are deliberately scoped
and do not claim to instrument every allocation inside dependency libraries.

## Selection and integration

`BENCH_ZIGZAG_TREE_R_BUILDER` selects `binary` or `legacy` in the full benchmark.
The native variable for Rust and dedicated Curio is
`FIL_PROOFS_ZIGZAG_TREE_R_BUILDER`. Empty and unknown values fail validation.
The default is **`legacy`** in Rust, the general runner and dedicated Curio.
The shared `just bench-zigzag-512` / `just bench-zigzag-32g` preset selects
**`binary`** with the **`stream`** layer pipeline. Full comparable runs,
including C1, remain necessary to assess performance; the single-tree timing
below does not establish a full-sealing speedup.
The runner forwards the selection to Docker and records it in provenance and
`cpu_configuration`; per-layer records identify the path actually used.

For a controlled comparison on the remote machine, use fresh full runs:

```sh
BENCH_ZIGZAG_TREE_R_BUILDER=legacy BENCH_ZIGZAG_LAYER_PIPELINE=sequential just bench-zigzag-512
BENCH_ZIGZAG_TREE_R_BUILDER=binary BENCH_ZIGZAG_LAYER_PIPELINE=sequential just bench-zigzag-512
```

Keep CPU, memory, allocator, parent-buffer/advice, loader, batch and query-cache
settings identical. Compare full TreeR including sync, all of PC1, C1 rereads
and total sealing. Do not infer a full-sealing speedup from fewer allocations
or one hash loop. No phase-only benchmark command is introduced.

The Rust implementation is committed and pinned at
`43d6961ad1e993d629e62c2de00cb9f78a2a8440`, the
[combined CPU/GPU revision](zigzag-gpu-groth16.md#cpu-updates-and-dependency-pin).
Fetch the managed sources and rebuild both dedicated images. Both build guards require the
`TreeRBuilder` API; source/overlay digests identify the exact code used.
The [layer-pipeline integration](zigzag-layer-pipeline.md) additionally
requires `LayerPipelineConfig` and provides opt-in `overlap` and `stream` modes.
For further uncommitted development, use an isolated source copy inside the
devnet context selected by `DEVNET_RUST_FIL_PROOFS_SOURCE`; do not edit managed
source checkouts. Keep all changes unstaged; never create commits automatically.

## Correctness acceptance

Remote tests compare whole files, not only roots, across small trees and chunk
boundaries, reopen stores and validate inclusion proofs. They check immutable
snapshots, bounded buffers, invalid inputs, retry, cancellation, short I/O,
write-zero errors and ENOSPC. A separate ignored test uses an explicitly
provided 1 MiB tmpfs to verify physical allocation failure and a smaller retry.

The ignored `full_size_store_matches_reference` fixture accepts exactly
512 MiB or 32 GiB through `ZIGZAG_TREE_TEST_BYTES`, plus an output directory in
`ZIGZAG_TREE_TEST_DIR`. It compares every byte with the old builder in bounded
buffers and records the common SHA-256, root and lengths in JSON. Temporary
input and stores are removed after success. This is a large compatibility
fixture, not a phase-only performance acceptance benchmark. Run Rust builds,
fixtures and full benchmarks only on the remote machine and sequentially.

Validation on 2026-10-14:

- Eight new focused Rust tests passed, as did five existing vanilla/replication
  tests and the real 1 MiB tmpfs ENOSPC/retry test.
- The 512 MiB compatibility fixture compared every store byte successfully:
  1,073,741,792 bytes, SHA-256
  `192e4e29d0559c88526641ac0d2e33fcff17738cf50ec398069e836facffb05f`.
  The candidate took 10.061 s including sync versus 17.002 s for the shared
  builder in this run. This is a diagnostic fixture result, not an accepted
  full PC1 or sealing speedup.
- The 32 GiB compatibility fixture also compared every byte successfully:
  68,719,476,704 bytes, SHA-256
  `8c1acfd17c8a46d30a00671728ef2a06d87bd1b9d0b586d6103f5398a5048abc`.
  It ran on NVMe/ext4 with a 12 GiB cgroup, whereas the 512 MiB fixture used
  HDD/XFS and 60 GiB. The candidate took **663.395 s versus 639.918 s** for the
  reference in this run (about 3.7% slower). These sequential fixtures on a
  shared host are not full performance acceptance. Do not extrapolate the
  512 MiB improvement to 32 GiB or compare absolute times across these setups.
  The initial HDD 32 GiB attempt was deliberately stopped while copying the
  reference leaves; only its own temporary files were removed before restarting
  on NVMe. Temporary large files were removed after the successful comparison.
- The dedicated microbench and Curio image builds passed with pinned Rust 1.94.
  A full 2 KiB FFI cycle used `binary`, produced a verified 192-byte proof and
  passed byte-for-byte unseal. `curio --version` and `sptool --version` passed.
  No live Curio task/lifecycle or standard SDR lifecycle was run.
- A full bench-512 comparison was pending at this validation. Future comparisons
  must use the same limit for both variants (currently 50 GiB base plus any requested query cache), with
  sufficient memory headroom for the other services on the remote machine.
  No service was stopped and the benchmark limit was not raised or lowered.
- Locally, 26 focused JS runner/report tests, the mandatory-API build guard,
  shell/Node static checks, Rust formatting and diff checks passed. Tests that
  create Git commits in fixtures were not run. No local Rust compilation,
  PoRep fixture or benchmark was run.

The downloaded JSON/Markdown evidence is in
[the validation report](../../.runtime/remote-runs/fidl-lab/2026-10-14-merkle-builder-validation/summary.md),
including both complete-store hashes, the final FFI result, image/source
identities and the distinction between correctness and performance acceptance.
