# ZigZag storage and retry correctness

The dedicated adapter and ZigZag library fixes address four cases:

- TreeD is built once and its root checked before encoding. Rejected pieces or
  a mismatched CommD drop the tree and remove only the newly created store.
  Corrected input can retry in the same cache. Rejection of an existing store
  never removes it. The caller must still serialize sector/cache operations;
  failures after encoding starts need fresh input and a private workspace.
- Regular-file FFI unseal output selects scratch in its parent directory.
  Proof cache contents and write permissions do not determine that location.
  Non-file output uses the caller's explicit cache-path argument as scratch.
  No implicit fallback selects `/tmp` or a memory-backed filesystem.
- Replica preparation and unseal share Linux disk-reservation and bounded
  read/write helpers. `FALLOC_FL_KEEP_SIZE` reserves space without concealing
  a short writer. Explicit copying avoids replacing reservations with shared
  reflink extents before mmap writes. Unsupported allocation returns an error.
- Valid empty ranges return after file/buffer and bounds validation, before
  scratch selection/allocation or decode. Both Rust range APIs preserve their
  input buffers for empty ranges. Invalid empty ranges remain errors.

Only ZigZag library modules, tests and the dedicated adapter change. There are
no changes to SDR, graph parameters, proof format or parameter-cache identity.

## Dependency rollout

This rollout pinned `versions.lock.yaml` to the published Rust revision
`ec49d9188fa893fd9401a0cc9bfe8c0251907547`, which contains the library fixes.
The current pin is recorded in `versions.lock.yaml` and
[`zigzag-capabilities.md`](../runtime/zigzag-capabilities.md). After updating
the lock, fetch the managed sources and rebuild the dedicated images so their
provenance records the selected pin.

The review builds below used a private copy based on
`56f94dddfbe6146623abd1caf7174ebe707085a6` through
`DEVNET_RUST_FIL_PROOFS_SOURCE`. Its source-content hash,
`2d16653512531aadfcc6f43d51f58edca88e4ac5abbfb585da3e87218bc0a0a8`,
matches the now-committed revision. Those historical manifests retain their
original provenance. No managed checkout was patched during the review.

Repin validation on the remote machine passed all 15 lock tests and verified
all ten managed sources, including a clean detached checkout of the new Rust
pin. This check used an isolated copy of the updated lock and tools, without
rebuilding images or rerunning proof benchmarks. Evidence is under
`.runtime/review-zigzag-repin-ec49d9188fa8-Ve08fe`.

## Validation

Proof tests, image builds and filesystem tests run only on the remote machine,
under `~/filecoin/porep-market-devnet`. Local checks are limited to source
inspection, formatting and syntax checks. Evidence is retained under
`.runtime/review-zigzag-storage-20261001`.

The test cases cover invalid pieces/CommD followed by a successful same-cache
retry, preservation of existing trees, unchanged buffers for empty ranges,
32 GiB empty requests with an unusable scratch path, short streamed input,
actual read-only cache mounting, ext4 ENOSPC and XFS reflink-capable storage.
Filesystem tests use private small loop images and bounded containers. The
XFS test first proves reflink support, then exhausts allocatable space and
writes every byte of the prepared replica through mmap.

Results on 2026-10-01: seven Rust library/API tests and fourteen FFI/storage
tests passed, including all three mounted-filesystem cases. The 85 selected
devnet/lock tests, TypeScript checking and static checks passed. Test mounts
were removed, temporary filesystem images deleted and the test container stopped.
Both dedicated images built successfully. The full 2 KiB cycle verified its
192-byte proof and recovered the original bytes; `curio` and `sptool` version
checks passed. Local Rust and overlay hashes match the built images. No live
Curio sealing task was run. Exact results are in the review directory's
`validation.json`; the cycle's JSON/Markdown reports are under `lifecycle/`.
