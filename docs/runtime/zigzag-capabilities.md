# ZigZag build capabilities

The dedicated adapters live under `source-overrides/zigzag`. `just build-zigzag`
builds the ZigZag microbench and Curio images; `just build` also builds them
alongside the standard images.

The lock pins `rust-fil-proofs` to
`b5237df450a6daa17dbfd0f953349dd177923e14`. This revision adds optional
TreeD/encode/TreeR operation boundaries used by the dedicated microbench to
report per-phase CPU, sampled memory and timing in the full cycle. Ordinary
Curio workers leave the measurement observer unset. It retains shared-L3 CPU
affinity for the ZigZag encoder and feeders on Linux with `hwloc` (enabled by
the existing `multicore-sdr` Cargo feature). Affinity defaults to enabled and
can be disabled with `FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_AFFINITY=false` in the
encoder process environment. If no suitable group of allowed physical cores
shares L3, encoding continues without pinning. It retains cleanup of newly
created TreeD stores when pre-encoding validation rejects the input and skips
decode for valid empty unseal ranges. Every dedicated ZigZag build includes:

| Required capability | Required Rust API |
| --- | --- |
| Separate C1 vanilla and C2 Groth16 proving | `zigzag_commit_phase1_from_cache`, `zigzag_commit_phase2` |
| Validated TreeD import | `zigzag_pre_commit_phase1_with_tree_d` |
| File-backed unseal with preallocated scratch | `zigzag_unseal_range_with_scratch` |
| Semantic C1 validation before reuse | `zigzag_validate_commit_phase1` |

These are unconditional parts of the dedicated adapter. There are no Cargo
features, `FFI_USE_*` switches or Docker build arguments for disabling them.
Both build scripts require all APIs before building; an older selected source
fails with a message naming the missing API. `DEVNET_RUST_FIL_PROOFS_SOURCE`
remains available for development, but also requires the complete API.
Compilation independently enforces the Rust signatures through direct calls.

Validation of this always-on policy on 2026-10-01 used the clean managed
checkout of the then-pinned revision
`56f94dddfbe6146623abd1caf7174ebe707085a6` on the remote machine. Both dedicated images
built successfully. Nine FFI tests, 85 devnet/lock tests, TypeScript checking
and static checks passed. The full 2 KiB cycle passed proof verification and
byte-for-byte unseal verification; `curio` and `sptool` version checks passed.
The old pinned source was explicitly rejected for its missing TreeD API.
The provenance test that creates a Git commit was excluded. The ENOSPC test
and large-sector measurements from the earlier reviews were not repeated.
Evidence is retained in `.runtime/review-required-zigzag-20261001`, including
the image manifests and the cycle's JSON/Markdown reports. No proof test,
benchmark or image build was run on the local workstation.

Microbench `cargoFeatures` now lists only `multicore-sdr`, `zigzag-bench` and
`zigzag-setup-status`. Both image manifests separately record the always-on
capabilities as `zigzagSplitProving`, `zigzagTreeDReuse`,
`zigzagFileBackedUnseal` and `zigzagC1Validation`, all `true`. Benchmark provenance
records these under `build.manifest.zigzag_capabilities`. These fields describe
the compiled adapter; they are not switches. The Curio image label identifying
split proving remains `io.porep-market.zigzag.split-proving`.

After updating the lock, fetch its managed sources and rebuild:

```sh
npm --prefix tools run cli -- sources fetch
just build-zigzag
```

The standard SDR adapter is unchanged. Updating the Rust pin brings in the
ZigZag-only library changes; the dedicated overlay is still separate from the
standard build. Completed legacy proof payloads remain readable for task
resumption. Old Rust implementation fallbacks are removed. Heap/mapped choices
remain only in the ignored unseal comparison test using the current Rust APIs.

## Historical rename inventory (2026-10-01)

The table records the earlier naming refactor. Its four capability feature
names and related build flags were subsequently removed by the always-on
policy above; they are no longer accepted Cargo options.

| Previous name | Current name |
| --- | --- |
| `source-overrides/zigzag-stage3` | `source-overrides/zigzag` |
| `just build-zigzag-stage3` | `just build-zigzag` |
| `zigzag-stage3`, `ZIGZAG_STAGE3`, `zigzag_stage3` | `zigzag-split-proving`, `ZIGZAG_SPLIT_PROVING`, `zigzag_split_proving` |
| `zigzag-stage2`, `ZIGZAG_STAGE2`, `zigzag_stage2` | `zigzag-tree-d-reuse`, `ZIGZAG_TREE_D_REUSE`, `zigzag_tree_d_reuse` |
| `zigzag-stage4`, `ZIGZAG_STAGE4`, `zigzag_stage4` | `zigzag-file-backed-unseal`, `ZIGZAG_FILE_BACKED_UNSEAL`, `zigzag_file_backed_unseal` |
| `zigzagStage2`, `zigzagStage4` | `zigzagTreeDReuse`, `zigzagFileBackedUnseal` |
| `devnet_zigzag_stage3_ffi_overrides_sha256` | `devnet_zigzag_ffi_overrides_sha256` |
| `stage3OverrideInputs` | `zigzagOverrideInputs` |
| `.zigzag-precommit-stage1` | `.zigzag-precommit-work` |
| `<sealed>.zigzag-stage1-pending` | `<sealed>.zigzag-precommit-pending` |
| `stage1-child-completed` | `precommit-child-completed` |
| `stage2-comparison.json`, `stage4-comparison.json` | `precommit-comparison.json`, `unseal-comparison.json` |

The original substitutions also covered `FFI_USE_*` flags, Docker arguments,
shell variables and conditional compilation, before those capability switches
were removed. There are no compatibility aliases using numbered names.

### Rust tests and fixture inputs

In `rust-fil-proofs`, the six test functions now describe their behavior:

- `decode_buffers_orientations_parity_and_workers`.
- `unseal_full_unaligned_ranges_and_invalid_bounds`.
- `single_tree_d_and_import_preserve_replica_and_all_layer_trees`.
- `precommit_invalid_inputs_fail_before_encoding`.
- `prepare_ten_partition_c1`.
- `prove_serialized_ten_partitions`.

The last two use `ZIGZAG_C1_FIXTURE_ROOT` instead of
`ZIGZAG_STAGE3_FIXTURE_ROOT`. Their remote-only status is unchanged.

The dedicated FFI test is now `test_zigzag_file_backed_ffi_unseal`. Precommit
child-process tests use `ZIGZAG_PRECOMMIT_CHILD_CACHE` and
`ZIGZAG_PRECOMMIT_CHILD_SPLIT`.

The ignored comparison tests are now `precommit_reference_comparison` and
`unseal_reference_comparison`. Their inputs are:

| Test | Environment variables |
| --- | --- |
| Precommit comparison | `ZIGZAG_PRECOMMIT_REFERENCE_WORK`, `ZIGZAG_PRECOMMIT_OUTPUT`, `ZIGZAG_PRECOMMIT_IMPORT_TREE_D` |
| Unseal comparison | `ZIGZAG_UNSEAL_REFERENCE_WORK`, `ZIGZAG_UNSEAL_OUTPUT`, `ZIGZAG_UNSEAL_MODE`, `ZIGZAG_UNSEAL_RANGE_OFFSET`, `ZIGZAG_UNSEAL_RANGE_SIZE` |

### Existing artifacts

The precommit lock filename remains `.zigzag-precommit.lock`. Completed replicas,
aux manifests, C1 payloads, Merkle stores and proof parameters retain their
formats and names. The rename affects only the private workspace and pending
replica. After a process interruption, artifacts using the previous temporary
names may remain; the new adapter neither trusts nor automatically deletes them.
Remove such incomplete artifacts only after stopping the older process and
confirming the sector cache is idle. The new names retain the normal retry and
cleanup behavior.

Historical review filenames, run directories and recorded image identities
retain their original names so evidence remains traceable. Current operator
instructions and rerun commands use capability names. Generic Filecoin terms
such as `staged_sector` / `staged_data_path` mean prepared input data, and Docker
build stages and profiling phases are unrelated to numbered plan steps.

Proof tests and builds run only on the remote machine under
`~/filecoin/porep-market-devnet`. Refactor validation evidence is retained in
`.runtime/review-capability-names-20261001`. No AI commits or staging changes
are part of this refactor.

Validation on 2026-10-01 passed: four Rust library tests, eight FFI tests,
69 devnet/runtime-lock tests, TypeScript checking and static checks. Both
dedicated images built with all four capabilities enabled. The full 2 KiB
seal/prove/verify/unseal cycle passed, as did `curio` / `sptool` version checks.
The two comparison harnesses and ten-partition C1/C2 fixture tests were compiled
and listed under their new names; their large or parameter-generating runs were
not repeated. No 512 MiB or 32 GiB benchmark was run for this naming refactor.
