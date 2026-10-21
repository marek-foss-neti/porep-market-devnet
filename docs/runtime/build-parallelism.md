# Build parallelism

`just build` and `just build-zigzag` automatically configure `CARGO_BUILD_JOBS`,
`GOMAXPROCS` and Go's `-p` compiler-process limit. This replaces the fixed value
of two. Resource selection runs inside each Linux builder immediately before
compilation, so it works with a remote Docker daemon and Docker Desktop's VM.
It does not change sealing, unsealing, benchmark or parameter-prewarm settings.

## Automatic budget

`scripts/build-resources.sh` reads CPU affinity from `/proc/self/status` and
available host memory from `/proc/meminfo`. It resolves cgroup v1/v2 mounts and
walks visible ancestors, applying the tightest CPU quota and remaining memory
budget (`limit - current usage`). Fractional CPU quotas round down, with a
minimum of one. A real cgroup v2 root without limit files is supported.
Missing or malformed counters below the visible root stop compilation with an
error instead of silently ignoring a possible limit.

The selector reserves one logical CPU when more than one is available and 10%
of available RAM, with a minimum RAM reserve of 2 GiB. It divides the remaining
CPU and RAM budgets between possible concurrent compilation branches, then
allows an estimated 2 GiB per job. The automatic job count is the smaller of
the CPU and memory shares, clamped to 1–128. Cargo and Go receive that count.

- Standard image: three possible parallel branches — Curio, Lotus and service
  tools — each receive one third of the budget.
- Dedicated ZigZag microbench and Curio images: each receives the single-branch
  budget. `just build` runs these two image builds sequentially.

For example, 128 available logical CPUs and 480 GiB available RAM produce 42
jobs per standard branch and 127 jobs for a dedicated ZigZag image. With 32 CPUs
and 100 GiB available RAM, these counts are 10 and 31. With 96 CPUs and only
18 GiB available RAM, memory reduces them to 2 and 8.

This is a conservative initial estimate, not a memory limit or a guarantee
against OOM: one compiler or linker can exceed 2 GiB. Even a small machine gets
at least one job. The selector takes a new snapshot for each wrapped build
command; it does not adjust a running compilation when other workloads grow.
The three-way split remains conservative when some standard branches are
already cached. GNU Make itself does not receive an unbounded `-j` setting.

## Overrides and diagnostics

Both settings default to `auto` and can be overridden independently:

```sh
DEVNET_BUILD_JOBS=16 DEVNET_BUILD_GO_PROCS=8 just build
DEVNET_BUILD_JOBS=auto DEVNET_BUILD_GO_PROCS=auto just build-zigzag
```

Explicit integers from 1 to 4096 bypass the corresponding automatic budget.
They apply per concurrent branch, not to the combined build. Empty strings,
zero and malformed values are rejected before building. Existing `GOFLAGS`
are preserved, with the selected `-p=N` appended for nested Go builds too.

Each executed compilation command logs a `build_resources` JSON record with
detected CPUs, available RAM, reserve, branch count and selected Cargo/Go
values. Standard-image BuildKit logs are retained under `.runtime/devnet/logs/`;
dedicated ZigZag builds print their BuildKit output to the terminal.

The helper is included in standard and ZigZag build-input hashes. A helper
change invalidates the corresponding image manifest. Resource overrides alone
do not force rebuilding an already valid standard image; they apply when
compilation runs. BuildKit cache hits also skip resource detection because no
compilation is needed. These settings are not persisted as runtime image
environment variables.

## Validation

Run the lightweight selector tests with `npm --prefix tools run
test:build-resources`; they are also part of `just test-unit`. Fixtures cover
cgroup v1/v2 ancestry, namespaced mounts, affinity, memory pressure, automatic
budgets, overrides and forwarding through all three build entry points.

A small BuildKit probe on the remote machine confirmed 42/127 automatic jobs
on a 128-thread host. A Docker probe limited to 2.5 CPUs and 4 GiB selected one
job, and a separate probe verified explicit Cargo/Go overrides. These probes
did not compile Rust or run a sealing benchmark; a complete image rebuild is
still needed to measure the actual compilation speed and peak memory.
