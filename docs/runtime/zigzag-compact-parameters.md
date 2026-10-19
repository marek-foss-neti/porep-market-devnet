# ZigZag compact Groth16 parameter indices

This update replaces the five per-point `Vec<Range<usize>>` indices in ZigZag C2
with five `QueryFamily` descriptors: section offset, point count and encoding
size. On a 64-bit host these descriptors occupy 120 bytes, independent of the
number of points. For the recorded zigzag-512 counts
`134217727 / 85358380 / 79463532 / 33436789 / 33436789`, the legacy vector
elements alone occupy 5,854,611,472 bytes. This is an index representation
comparison, not a measured reduction of process RSS or the C2 memory peak.

## Integration and identity

`storage-proofs-porep/src/zigzag/parameters.rs` implements Bellperson 0.27.0's
public `ParameterSource<Bls12>`. The compact variant is selected before any
`MappedParameters` construction. H/L/A/B-G1/B-G2 decode on demand into the same
`Arc<Vec<Affine>>` builders, preserving ordering and input/aux offsets. Decoded
queries are released by the existing prover; no query cache or allocator tuning
is introduced by the loader. Each family is decoded in parallel into one
initialized destination vector, avoiding the intermediate vectors and final
merge of parallel `Result<Vec<_>>` collection. This still materializes the full
query family; it is not a streaming MSM source. Query decoding, FFT and MSM
still require substantial memory.

An optional [per-C2 query adapter](zigzag-query-cache.md) can now retain selected
decoded families between batches. It is separate from this loader and defaults
to off. With retention enabled, batch return releases the prover's builders,
while the adapter retains selected points until the enclosing C2 call returns.

Ordinary `zigzag_prove` and split `zigzag_commit_phase2` use the new source and
the existing Bellperson batch prover. Dedicated FFI/Curio reaches these APIs
without changing their external signatures. The ZigZag parameter cache uses
the full parameter identifier and validates the opened file's identity and VK
on reuse. Shared SDR types and parameter loading remain unchanged. Explicit
calls to the shared `CacheableParameters::get_groth_params` trait retain its
legacy return type for compatibility; production ZigZag C2 and prewarm use the
new inherent entry points.

`cuda-supraseal` has a separate compile-time path: its native
`SuprasealParameters` goes to Bellperson's concrete Supraseal batch entry point,
including the compatibility `CompoundProof` path. The feature is forwarded from
`filecoin-proofs` to `storage-proofs-porep` and the existing core/Bellperson
features. Compact/mapped selection applies to CPU and ordinary CUDA/OpenCL;
Supraseal uses its native SRS regardless of that selector. Its diagnostics report
`supraseal` and leave native index allocation and query-cache state unknown. This
change does not replace the native backend's query storage.

The loader checks counts, checked offset arithmetic, every section boundary and
the exact file length before decoding the bounded VK prefix. It preserves
checked/unchecked query decoding and rejects invalid encodings and infinity.
Production parameter verification hashes the same opened descriptor that is
mapped. A shared file lock covers opening and validation, then is released so
legacy readers can acquire their exclusive read locks while the source lives.
The retained descriptor, file identity and VK digest bind the mapping to the
immutable published parameter file. Replacing a pathname cannot redirect an
existing source; a subsequent cache lookup validates the new file.
Published files must remain immutable while mapped, as with the legacy loader.
The `.params`/`.vk` formats, parameter ID, circuit and setup do not change.
If `.vk` disappears while parameters are in the process cache, the existing
publication lock protects reconstruction from the loaded VK. The same source is
retained, without reloading index vectors or regenerating parameters. An existing
incompatible VK still causes an error.
If initialization or validation panics and FFI catches the unwind, the next
ZigZag lookup recovers the cache mutex. Loading publishes only a complete source,
so recovery preserves existing entries and retries the usual file/VK checks;
it does not bypass validation or allow concurrent duplicate initialization.

## Runtime controls and reports

| Process | Variable | Default / values |
| --- | --- | --- |
| Full microbench and prewarm | `BENCH_ZIGZAG_PARAMETER_LOADER` | `compact`; `compact` or `mapped` |
| Rust API and dedicated Curio | `FIL_PROOFS_ZIGZAG_PARAMETER_LOADER` | `compact`; `compact` or `mapped` |
| ZigZag benchmark base RAM (except standalone prewarm) | `BENCH_ZIGZAG_FULL_MEMORY_BYTES` | 53,687,091,200 (50 GiB); full-run query cache is added on top |
| Standalone prewarm RAM | `BENCH_ZIGZAG_SETUP_MEMORY_BYTES` | 53,687,091,200 (50 GiB); positive overrides up to 80 GiB |
| Setup allocation check | `BENCH_ZIGZAG_SETUP_BUDGET_BYTES` | 42,949,672,960 (40 GiB); lower-bound check, not a runtime cap |

The benchmark override takes precedence over the native loader setting and is
passed explicitly to Docker. The dedicated Curio Compose override and launchers
use the native setting. Selection is fixed for the lifetime of a process;
comparison requires separate processes. Standard SDR does not receive it.
The existing memory/swap contract stays in place: Docker memory-swap equals
memory, meaning no additional swap. A lower explicit RAM limit is supported;
the base default is 50 GiB. Full runs add the requested query cache on top
and default its reserve to the base; prewarm receives only the base. Active-cache
totals must fit the current loader's 60 GiB ceiling. Runs without active cache
retain the 80 GiB override ceiling. See [query-cache policy](zigzag-query-cache.md).
The full 512 MiB workload passed at the former 60 GiB default in the three
2026-10-12 runs described below; this establishes neither a 50 GiB acceptance
nor a 32 GiB result. The benchmark cap is container-wide and applies to all
ZigZag benchmark modes; SDR and Curio services are outside this setting.

The full runner records `groth16_parameter_load`, `groth16_query_*`,
`groth16_batch` and `groth16_c2` boundaries. Batch details identify the zero-based
partition range. `groth16_c2` surrounds the shared circuit/batch proving function
in both ordinary and split proving. It excludes parameter loading, vanilla
generation/validation, API-level VK lookup and final seal-proof serialization.
Ordinary proving records separate `vanilla_proving` and `vanilla_verification`
operations; parameter loading remains `groth16_parameter_load`. The enclosing
benchmark phase still measures the whole API call, so sealing totals retain all
of that work. The batch end follows the return from Bellperson, after its
circuits and query builders are released. Operation and phase
`boundary_snapshots` retain process RSS anon/file and cgroup counters, I/O and
PSI before/after, including after C2. The normal Curio worker does not install
the benchmark observer.

`groth16_parameters` retains layout metadata, per-family encoded/decoded sizes,
decode wall time, parameter/file identity and VK digest from the explicit
`zigzag_parameters {JSON}` message marker. The parser supports fil_logger's
module-path text and JSON envelopes. `c2_suboperations` retains the measured
windows. JSON, Markdown and provenance record the selected loader, effective
cgroup budget and existing allocator environment configuration. These values
do not identify free allocator memory or establish the loaded allocator/library
version.

Interrupted full runs retain partial telemetry, missing end boundaries, Docker
exit/OOM state and the diagnostic logs. The runner captures the final container
state and persists the report before removing its stopped container. It retains
the container if inspection/reporting fails or the container is still running.
An incomplete run does not claim a successful sealing total.
After successful JSON and Markdown output, cleanup errors are recorded separately
in `post-run-error.json`, including the failed operation, exit codes, diagnostic
log and final container state. The script still exits nonzero, but retains the
successful benchmark, phase table, telemetry and provenance.

## Validation status and later measurement

As of 2026-10-13, the three recorded full bench-512 runs from 2026-10-12 in
`.runtime/remote-runs/fidl-lab` and `.runtime/remote-runs/holland` passed all ten
partitions, proof verification and unseal at 60 GiB, with the compact loader,
batch 1 and `MALLOC_ARENA_MAX=4`. This validates the combined configuration for
those runs; it does not isolate the allocator's contribution, validate 55 GiB,
or establish a 32 GiB sector result. The earlier focused loader validation is
described next; optional query-retention validation is tracked separately in
[zigzag-query-cache.md](zigzag-query-cache.md).

All eight loader tests passed on the remote machine with the dedicated image's
pinned Rust 1.94 toolchain. They compare all families and splits against legacy
Bellperson, checked/subgroup semantics, invalid/truncated/trailing files, overflow,
path replacement, concurrent reads and a legacy cache reader with a live compact
source. The added regression uses 4,097 G1/G2 points and four Rayon workers to
check ordering and rejection of a corrupt last point in checked and unchecked
mode. Fresh-process checks also reject an
invalid loader setting and an unknown fixture with production verification
enabled. A tiny multiplication circuit produces
and verifies proofs after fresh process starts with both loader variants and
existing parameters. All 24 focused runner/report tests also passed locally and
on the remote machine. Formatting and diff checks passed.

The earlier local validation additionally included four small cache tests
covering partial files, concurrent cache creation, missing VK repair and
ready-cache validation without a writer lock, including a replaced VK. These are not full PoRep lifecycle tests.
A memory-cache regression loads a tiny fixture, deletes `.vk`, repeats lookup in
the same process and checks source reuse, identical parameter/VK bytes and
rejection of a replaced VK. It runs separately with both loader variants.
A separate cache regression injects panics before source publication and with
an existing entry, then checks successful retry, source reuse, cleared mutex
poisoning and unchanged parameter/VK files for both loaders.
Five sampler tests include actual operation recording on both boundaries and
compatibility of events without details. Report/configuration tests cover
module-path/JSON logs, memory/swap limits, Curio launchers and interrupted/OOM
reporting before container removal, plus failures of artifact cleanup and BuildKit
pruning after successful report output.

Rust build and test commands below are for the remote machine, from the selected
Rust checkout. They do not run a full benchmark:

```sh
cargo test --release --locked --no-default-features --features multicore-sdr \
  -p storage-proofs-porep --lib zigzag::parameters::tests
FIL_PROOFS_PARAMETER_CACHE=/tmp/zigzag-compact-parameter-cache \
  cargo +stable test --locked --no-default-features -p storage-proofs-porep \
  zigzag::circuit::compound::tests -- --skip zigzag_compound_groth16_roundtrip
cargo +stable check --locked --no-default-features -p filecoin-proofs --tests
cargo +stable test --locked --no-default-features -p filecoin-proofs --lib \
  caches::tests::zigzag_memory_cache
```

Lightweight runner/report and static checks run from the devnet repository:

```sh
npm --prefix tools run test:measurements
npm --prefix tools run test:cpu-settings
bash scripts/static-checks.sh
```

The earlier local checks used stable Rust 1.97.1 on macOS. The subsequent remote
loader tests and microbench build used the pinned image toolchain. The remote
image was built from an isolated development copy containing the allocation fix;
the two changed Rust files match the newly pinned commit byte for byte. This
does not establish that images have already been rebuilt from the new lock.
An updated dedicated Curio image and actual Curio sealing remain separate
acceptance checks. The later full bench-512 results are recorded above; no
result is extrapolated to 32 GiB.

Remote bench-512 attempts on 2026-10-09 used the same profile and parameter file:

| Attempt | Settings | Outcome |
| --- | --- | --- |
| Original compact loader | 60 GiB, default allocator | Container OOM during partition 3 |
| Original compact loader | 55 GiB, `MALLOC_ARENA_MAX=4` | Three partitions completed; container OOM during partition 4 |
| Direct-destination decoding | 55 GiB, `MALLOC_ARENA_MAX=4` | Four partitions completed; paused and then stopped during partition 5 by the shared-host memory guard; `OOMKilled=false` |

The allocation-fix run reached 40.9–41.2 GiB sampled anonymous RSS in the four
completed batches and returned to about 0.21 GiB after each batch. The cgroup
peak reached the 55 GiB limit including file cache; benchmark swap remained zero.
Increasing memory use by another service caused the protective stop, so the
full proof verification and unseal were not reached. This is partial evidence
of lower, stable anonymous memory, not proof of a safe complete-run RAM budget.

The first three complete batches averaged 367.8 seconds before the allocation
fix and 364.4 seconds after it, both with a 55 GiB cap and arena limit 4. These
small differences on a shared host do not establish a speedup or regression.
The completed batch timings precede the pause; total interrupted-run wall time
must not be treated as a full performance baseline.

Evidence is retained on the remote machine in
`.runtime/runs/2026-10-09T19-38-46-780Z-bench-proof-micro-zigzag-512mib-zigzag-512/`,
including `report.json`, `container.json`, `diagnosis.json` and host-pressure
diagnostics. JSON/Markdown copies are under `.runtime/remote-runs/<remote-name>/`.
These runtime artifacts are not checked into Git.

Supraseal feature forwarding was checked using Cargo metadata and its concrete
entry point against the pinned Bellperson source. The native CUDA/Supraseal build
and GPU proof were not validated on this macOS ARM host without a CUDA toolchain.
An offline native `cargo check` stopped before compilation because `cuda-config`
was not present in the local Cargo cache.
On a CUDA-enabled machine, check the Rust/API configuration with
`cargo check --locked --no-default-features -p filecoin-proofs --tests --features cuda-supraseal`
before claiming a validated native build.

Devnet pins the committed implementation at
`7a94e1cfe322a9908dd17ab5a09c9cf96029b073`, including direct query decoding
into one initialized vector, cache recovery after panics and consistent Groth16
circuit/batch boundaries. It also includes the optional per-C2 query adapter
with corrected cgroup-v2 root-limit detection and circuit-preparation measurements;
retention defaults to off. Fetch the managed sources before
rebuilding the dedicated images. Their build guard requires the compact API and
manifests record `zigzagCompactParameters`.
An isolated development copy must include the complete modified Rust source;
do not edit a managed checkout. Source/overlay digests identify that exact copy.
The next acceptance run must use the existing full bench-512 on the remote
machine with ready parameters and sufficient host memory throughout the run.
Record explicit allocator, batch and CPU settings; compare identical settings
when evaluating the loader. Acceptance requires all ten partitions, proof
verification and byte-for-byte unseal, plus memory, I/O, PSI, OOM and swap data.
The former 60 GiB default passed the recorded 512 MiB runs above; no 50 GiB or
32 GiB result is established by those runs. No local benchmark or prewarm should be
started, and diagnostic changes must remain unstaged for manual review; never
stage files or create commits automatically.
