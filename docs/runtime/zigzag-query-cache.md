# ZigZag Groth16 query reuse within one C2

The optional query cache retains selected decoded Bellperson query families
between batches of **one** ZigZag C2 call. It is disabled by default, including
the `just bench-zigzag-512` comparison preset. Enable it explicitly for a full
CPU comparison; do not interpret its availability as an accepted speedup.

## Evidence and candidate

The three full 512 MiB runs from 2026-10-12 in
`.runtime/remote-runs/fidl-lab` and `.runtime/remote-runs/holland` completed all
ten partitions, proof verification and unseal at 60 GiB with the compact loader,
batch 1 and `MALLOC_ARENA_MAX=4`. Every query family was decoded ten times.
Their C2 times were approximately 3528, 3503 and 3476 seconds.

| Query family | Decoded point storage, GiB |
| --- | ---: |
| H | 12.000 |
| L | 7.632 |
| A | 7.105 |
| B-G1 | 2.989 |
| B-G2 | 5.979 |

The initial candidate has a 4 GiB retention budget and selects only B-G1
(3,209,931,744 bytes). The summed B-G1 decode intervals were about 195/196 seconds
on fidl-lab and 59 seconds on holland. These intervals overlap prover work;
avoiding nine decodes does **not** imply the same reduction in C2 wall time.
Recorded anonymous RSS peaks were approximately 41.2 and 45.9 GiB. The cgroup
also includes file cache and other memory, and reached its 60 GiB limit. These
measurements motivate an experiment, not a guarantee of memory headroom.

## Implementation and memory policy

`storage-proofs-porep/src/zigzag/parameters/query_cache.rs` implements a local
adapter for Bellperson's public `ParameterSource`. Ordinary and split ZigZag
proving use it through `circuit_proofs_with_parameters`. SDR, the Bellperson
dependency, circuit, parameter ID, parameter files and VK are unchanged.
The compact loader remains responsible for decoding and checked/unchecked point
validation; the adapter also supports the legacy mapped source for comparisons.

Before decoding, the adapter reserves complete families, smallest first, within
the effective budget. Each family has a separate initialization mutex. A miss
decodes once and retains its `Arc<Vec<Affine>>`; hits clone only the `Arc`.
Input/aux offsets, ordering, G1/G2 types and bounds checks are preserved. A failed
or panicking initializer leaves its slot empty, allowing a retry. Vec capacity
is checked before retention; an oversized allocation is used for the current
proof without being retained.

There is no eviction and no global decoded-query cache. Every returned builder
and retained entry refers to the same allocation, so an active `Arc` cannot
escape accounting through eviction. The source is borrowed from one validated,
immutable parameter mapping; another C2 creates an independent cache. Successful
batches await their MSM results. On error, Bellperson/ec-gpu-gen can leave CPU
tasks finishing after its `Waiter` is dropped. The adapter then releases its own
references; outstanding builders keep their allocations alive until those tasks
finish. This preserves the existing prover cleanup behavior and does not promise
immediate RSS release after an error or a process-wide budget for overlapping C2s.
Files must remain immutable while mapped, as required by the existing loader.

The effective point-storage budget is:

```text
min(requested_cache, max(0, min(detected_cgroup_limit, 60 GiB) - reserve))
```

The generic Rust/Curio reserve remains **56 GiB**. The benchmark runner instead
sets it to the base budget, **50 GiB** by default, for witness, FFT/MSM, other
query families, transient decoding, mmap/file residency and allocator overhead.
For full runs, requested cache is added **on top**: a 4 GiB request gives a
54 GiB measured container and a 50 GiB reserve, so the cache can retain up to
4 GiB. Full-run prewarm, fixture preparation and standalone unseal receive only
the base budget; standalone prewarm retains its separate 50 GiB default.
This applies to all ZigZag sector sizes, including 512 MiB and 32 GiB.

The reserve is a planning allowance, not a separate kernel-enforced partition
or live-RSS measurement. Docker enforces the sum for the whole container.
The current Rust adapter still clamps its calculation at 60 GiB: the runner
rejects active-cache configurations whose base plus cache exceeds 60 GiB
(default base therefore permits at most 10 GiB of cache). An explicit reserve
must equal the base; unset old 56 GiB reserve overrides when using the 50 GiB
base. This avoids silently reducing the requested cache. The 80 GiB global
container ceiling remains available for runs without active cache. Retaining
points can increase reclaim even when anonymous RSS fits, so acceptance must
check full C2 time, faults, I/O, PSI and OOM as well as peak RAM.

The reader checks the process's cgroup and its visible ancestors at standard
Linux v1/v2 memory mount paths, using the lowest finite limit. An unresolved,
nonstandard or unlimited hierarchy disables retention. Budgets are per C2;
the caller/scheduler must account separately for concurrent jobs and other
services. No host memory, other service or SDR setting is changed. Neither
32 GiB sectors nor GPU have a validated cache budget. Supraseal uses its separate
native source and does not use this adapter.

## Configuration and reports

| Benchmark override | Rust / dedicated Curio variable | Default |
| --- | --- | ---: |
| `BENCH_ZIGZAG_QUERY_CACHE_BYTES` | `FIL_PROOFS_ZIGZAG_QUERY_CACHE_BYTES` | `0` |
| `BENCH_ZIGZAG_QUERY_CACHE_RESERVE_BYTES` | `FIL_PROOFS_ZIGZAG_QUERY_CACHE_RESERVE_BYTES` | Benchmark: base budget, normally `53687091200` (50 GiB); generic Rust/Curio: `60129542144` (56 GiB) |

Values are integer bytes, capped at 60 GiB; the reserve must be positive. The
benchmark explicitly forwards both variables into its ZigZag containers and
records the effective configuration in `memory-budget.json`, provenance,
`report.json` and `summary.md`. Configured cache allowance and actual retained
families are reported separately. Dedicated Curio launchers and Compose use the
same native variables but do not inherit this benchmark memory policy. Prewarm
does not run C2 and does not populate this cache.

```bash
BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296 just bench-zigzag-512
```

This requests 50 GiB base + 4 GiB cache = 54 GiB RAM, with swap disabled.
Cache remains disabled by default; changing this runner policy needs no rebuild.

`groth16_parameters` in `report.json` contains `query_cache` configuration,
selected families and reserved bytes, plus per-family `query_cache_access`
events (`hit`, `miss_retained`, `skip_capacity`). `summary.md` includes the
configuration and hit/miss table. The loader's existing
`decoded_query_cache: false` describes the underlying loader; the separate
per-C2 adapter is described by these new events.
`groth16_query_*` decode timers occur on misses only.
`groth16_circuit_prepare` measures circuit construction separately inside every
batch; overlapping timers must not be added to full C2 time. No owned-proof
constructor or R1CS change is made without measured evidence that preparation
is significant.

## Validation

Run Rust builds, tests and full benchmarks only on the remote machine. Devnet
now pins the committed implementation, including the cgroup-root fix, at
`74d72f778664c10d19105b5401976205864f0b9d`. Fetch the managed sources and rebuild
the dedicated images to use this revision. For further uncommitted changes,
use an isolated source copy via `DEVNET_RUST_FIL_PROOFS_SOURCE`, not a managed
checkout. The build guard requires the adapter API. Keep all development changes
unstaged for manual review; do not create commits automatically.

The focused tests cover budget clipping, nested cgroup limits (including a real
v2 root without `memory.max`, a tighter namespaced-root limit and unresolved
hierarchies that must disable retention), offsets and
bounds on cache hits, all five families, zero-budget fallback, independent
sources, cache lifetime, concurrent initialization, failed/panicking fills and
overallocated vectors. A small existing-parameter proof test warms the adapter,
then compares a hit with Bellperson using identical randomness and verifies the
proof. Runner tests cover defaults, overrides, invalid budgets, Compose and
JSON/Markdown records.

The historical candidate used `BENCH_ZIGZAG_QUERY_CACHE_BYTES=4294967296`
and a 60 GiB container, with the reference using `BENCH_ZIGZAG_QUERY_CACHE_BYTES=0`.
With the current 50 GiB base, cache off uses a 50 GiB container and a 4 GiB
cache request uses 54 GiB. This compares base-plus-cache configurations, not
cache alone at a fixed total RAM limit. For a fixed-total comparison, use a
54 GiB base with cache off versus a 50 GiB base plus 4 GiB cache; record the
different base budgets. Neither configuration has been validated by the
historical 60 GiB run. Keep batch 1 and the other settings identical. Check one B-G1
decode followed by nine hits, all ten proofs, verification and unseal. Compare
C2 and the full sealing path with comparable host load/cache state. Batch 2
requires its own on/off comparison and memory check; do not add its expected
benefit to that of retention. A weak or negative result leaves retention off.

Validation on 2026-10-13:

- Remote pinned Rust 1.94 release build of the dedicated microbench succeeded.
- All 14 focused Rust tests passed: eight loader tests, including the extended
  fresh-process proof check for both loaders, and six cache tests.
- A remote 2 KiB full FFI run passed seal/prove/verify/unseal with retention
  enabled, a 12 GiB cgroup and a deliberately smaller 1 GiB reserve for that
  fixture. It retained 616,093,248 bytes across all five families and produced
  a valid 192-byte proof. This is an integration check, not a 512 MiB performance
  measurement or a recommended reserve for large circuits.
- Locally, 25 runner/report tests and two focused build/preset tests passed;
  shell/Node static checks, Rust formatting and diff checks passed.
- The full remote bench-512 completed successfully from the isolated review
  copy: `2026-10-13T10-35-36-705Z-bench-proof-micro-zigzag-512mib-zigzag-512`.
  It used a 4 GiB cache request, the default 56 GiB reserve, batch 1 and a
  60 GiB cgroup. All ten partitions completed; seal verification and byte-for-byte
  raw unseal checks passed. B-G1 retained 3,209,931,744 bytes (about 2.99 GiB),
  with one retained miss followed by nine hits. There were no OOM events or
  OOM kills and no swap use. The cgroup peak reached 60 GiB; this does not
  establish spare memory headroom.
- C2 took 3,392,187 ms (56 min 32.187 s), compared with 3,528,216 ms and
  3,503,358 ms in the two preceding cache-off runs on the same remote machine
  (`2026-10-12T13-19-29-289Z` and `2026-10-12T15-55-03-715Z`). This is about
  3.5% below their mean. One cache-on run against earlier builds on a shared
  host confirms correctness and cache reuse, but does not establish a repeatable
  speedup attributable to retention. Matched cache-on/off comparisons and the
  separate batch-2 comparison remain pending. Retention stays off by default.

The downloaded evidence is under
`.runtime/remote-runs/fidl-lab/2026-10-13T10-35-36-705Z-bench-proof-micro-zigzag-512mib-zigzag-512/`:
`summary.json` records proof/unseal results and phase times, `report.json` records
query-cache events, and `telemetry-summary.json` records memory and OOM counters.
This completed run predates the cgroup-root fix; its cache was active, so it
does not exercise the missing-root-file regression.

Follow-up validation on 2026-10-14: all 16 focused Rust tests passed on the
remote machine (eight loader tests and eight cache tests). The new missing-v2-root
regression failed against the previous implementation (`None` instead of the
60 GiB descendant limit) and passed after the fix. Coverage also checks a
tighter namespaced-root limit, missing intermediate files, unreadable/malformed
root limits, and the unchanged fail-closed behavior for a missing v1 root limit.
No additional full benchmark was run for this detection-only fix.
