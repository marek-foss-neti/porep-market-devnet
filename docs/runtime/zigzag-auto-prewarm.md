# Automatic ZigZag parameter prewarm

The file-backed ZigZag Groth16 generator defaults to `auto` instead of 16
workers. It chooses H and A/B/L query concurrency separately from available CPUs,
the circuit dimensions and memory headroom. This changes scheduling only:
constraint ordering, random draws, query ordering, point encoding, parameter
cache IDs and the Bellperson-compatible parameter format are preserved.
SDR's generator is unchanged. Encoder feeders still default to two.

## Controls and scope

| Setting | Default / meaning |
| --- | --- |
| `BENCH_ZIGZAG_SETUP_WORKERS` | `auto`; explicit integer 1–128 supported |
| `FIL_PROOFS_ZIGZAG_SETUP_WORKERS` | Native equivalent, used when the benchmark override is absent; Rust also defaults to `auto` |
| `BENCH_ZIGZAG_SETUP_BATCH_POINTS` | 65536; unchanged per-worker buffer capacity |
| `BENCH_ZIGZAG_SETUP_BUDGET_BYTES` | 42949672960 (40 GiB); unchanged generator admission budget |
| Prewarm container RAM | 53687091200 (50 GiB); query cache is not added during prewarm |

Both `just bench-zigzag-512` and `just bench-zigzag-32g` inherit this default from
the general benchmark runner. `BENCH_*` overrides the native worker setting.
An explicitly empty worker setting is invalid. For a manual comparison:

```sh
BENCH_ZIGZAG_SETUP_WORKERS=16 just bench-zigzag-512
```

The dedicated ZigZag Curio Compose environment passes the native worker setting,
defaulting to `auto`. A direct Rust/Curio invocation retains the previous native
`FIL_PROOFS_ZIGZAG_SETUP_BUDGET_BYTES` fallback of 100000000000 bytes; it does not
inherit the benchmark's 40 GiB budget or Docker RAM limit. Auto additionally
clamps that configured budget to the detected host/cgroup headroom.

Existing valid parameters are reused. A cache hit needs no H/query generation,
so it cannot measure this optimization. Parent-table preparation, circuit
synthesis, FFT/QAP, verification-key loading and proving are separate work;
the H/query worker count does not control all prewarm phases. Domain/FFT work
continues using its existing ec-gpu CPU pool.

## Selection policy

After constraint synthesis determines domain size `m`, total variables `n` and
public inputs, the generator estimates the fixed and per-worker allocations
using the actual Rust field/projective/affine type sizes. Linux resource reads
include process `RssAnon + VmSwap`, host `MemAvailable`, and cgroup v1/v2 memory
limits and current usage along every visible ancestor up to the cgroup mount.
Membership and mountinfo resolve the actual cgroup location, including subtree
mounts. A missing `memory.max` at the real v2 root preserves descendant limits;
other required read/parse failures return an error rather than assume unlimited
RAM. Invisible ancestors outside a container's cgroup namespace cannot be read.

Only clean inactive file pages are counted as reclaimable: inactive file bytes
minus dirty and writeback bytes, saturated at zero. Missing/incomplete
`memory.stat` contributes no reclaimable pages. For each finite ancestor, usable
headroom is its limit minus current usage after that conservative adjustment.
The smallest headroom across ancestors applies, including usage by sibling
processes. Non-Linux uses CPU/configured-budget estimates without these Linux
memory counters; it is not the benchmark acceptance target.

The effective total process budget is the minimum of:

- the configured generator budget;
- the smallest visible cgroup hard limit;
- current anonymous process memory plus host available memory;
- current anonymous process memory plus cgroup available memory.

Auto reserves `max(512 MiB, 10% of the effective budget)` for allocator, library
and file-cache overhead. H includes the power domain plus each worker's point
buffers; queries include the three A/B/C field arrays, IC storage and each
worker's G1/G2 buffers. Per-worker estimates include normalization scratch and
8 MiB for segment I/O, thread stack and WNAF scratch. Batch size remains fixed.

For each phase:

```text
CPU limit = min(available_parallelism, Rayon pool size, 128)
work limit = max(1, ceil(phase items / batch points))
memory limit = floor((effective budget - reserve - fixed bytes) / worker bytes)
workers = min(CPU limit, work limit, memory limit)
```

An explicit Rayon limit also constrains automatic setup workers. CPU availability
means the process/container's allowed logical parallelism, not currently idle
cores. No worker threads or RAM are exclusively reserved.

Before H, the generator rejects an impossible domain/IFFT/QAP peak and an
impossible later query phase. It samples resources again at H entry, after H
before IFFT/QAP, and at query entry. The later check includes retained H worker
allocations; query sizing includes current anonymous memory without adding the
resident A/B/C arrays twice. If even one worker cannot fit, it reports the
budget/fixed/buffer estimates and fails before launching that phase. Fewer
workers cannot fix an oversized domain/QAP allocation. No retry deletes or
replaces valid cached parameter files.

This is phase-boundary admission, not dynamic resizing or an OOM guarantee.
Changing host load, allocator behavior, disk writeback and other processes can
consume the headroom later. Reports distinguish estimates from measured peaks.
Explicit numeric worker settings keep the previous scheduling and lower-bound
memory check, including the new maximum of 128; auto CPU/headroom checks are not
silently applied to a manual count. Manual values can oversubscribe CPUs.

## Reports and validation

`zigzag_setup=info` is enabled by the benchmark and the default dedicated Curio
logging configuration. Each executed H/query phase emits a
`zigzag_setup_workers` JSON record with the requested/effective workers,
CPU/work/memory limits, configured/effective budget, reserve, allocation
estimates, limiting factors and resource snapshot. Manual records identify the
explicit count without inventing automatic estimates.

The benchmark copies these records from `param-prewarm.stderr.log` into
`report.json.prewarm_worker_plans` and adds a worker table to `summary.md`.
Cache hits have no plans; successful reports identify the cache hit explicitly.
Failure JSON retains available plans, even if later C2 fails. These diagnostics
do not change the sealing timers or add prewarm time to sealing totals.

Implementation status (2026-10-21): local configuration/report tests and
syntax/format checks passed. Added Rust tests cover worker parsing, CPU/work/RAM
bounds, retained allocations, cgroup ancestry/mounts and automatic generation
against Bellperson's serialized output. **They have not been executed.** At the
user's request, Rust tests/builds are deferred until the active benchmark on the
remote machine finishes. No local Rust build or benchmark is allowed.

After the remote machine is free, use an isolated checkout to run the policy,
resource, setup and existing parameter correctness tests. Then validate a fresh
parameter generation with constrained CPU/RAM, inspect both worker records and
cgroup peaks, and verify parameter/VK and full proof/unseal correctness. Existing
parameters must be preserved; a separate parameter directory provides a miss.
Do not claim a speedup from cache-hit prewarm or simulated configuration tests.

The CPU implementation was committed at
`b1cec2213b8132adc6164ccb5a289c35e279eadf`, with the build fix at
`74d72f778664c10d19105b5401976205864f0b9d`. Both changes are included in the
published `restore-zigzag-gpu` commit
`d4c6c3e8124fe7b64730246297910adfa1606ab4`, now pinned in `versions.lock.yaml`.
Fetch managed sources and rebuild before using this default; old binaries do
not understand `SETUP_WORKERS=auto`. No development-source override is needed
for this pin. A repin does not complete the deferred Rust validation above.
Keep changes unstaged for manual review; do not stage files or create commits
automatically.
