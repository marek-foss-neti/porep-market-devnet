# ZigZag Groth16 on GPU

The dedicated ZigZag worker can compile native Bellperson 0.27.0 with CUDA or OpenCL. CUDA is the initial acceptance backend. This uses the existing batched prover and compact `ParameterSource`; it does not fork Bellperson, change the circuit, regenerate parameters, or change SDR images. Parameter prewarm still runs on the CPU with the disk-backed generator.

## CPU updates and dependency pin

The GPU working tree now includes the CPU changes from `test-zigzag` through
`e1f3f8d`: background-writeback and pipeline-wait reporting, TreeR eviction at
C2, the 50 GiB base budget with query cache on top, the shared 512 MiB/32 GiB
runner, automatic prewarm with worker diagnostics, worker limits up to 128,
the updated benchmark preset and automatic Cargo/Go build parallelism.
The corresponding Rust CPU reference is
`74d72f778664c10d19105b5401976205864f0b9d`, including the setup build fix.

`versions.lock.yaml` pins the combined CPU/GPU implementation to
`d4c6c3e8124fe7b64730246297910adfa1606ab4` on `restore-zigzag-gpu`.
It includes background writeback, wait metrics and the
`zigzag_commit_phase2_with_cache` API required by the updated FFI and
microbench, while preserving native Bellperson GPU proving and device
admission. This published revision also includes automatic prewarm, worker
limits up to 128 and the setup build fix. Fetch the managed sources and rebuild
the dedicated images on the remote machine before using `SETUP_WORKERS=auto`;
this pin needs no development-source override. For further uncommitted Rust
changes, use an isolated source copy selected through
`DEVNET_RUST_FIL_PROOFS_SOURCE`. The repin does not replace remote Rust or GPU
runtime validation.
Keep changes unstaged for manual review; never stage or commit automatically.

## Build variants

Only build on the remote machine. The `test-zigzag-gpu` devnet branch pins `rust-fil-proofs` to commit `d4c6c3e8124fe7b64730246297910adfa1606ab4` on `restore-zigzag-gpu`. For further uncommitted development, an isolated source copy can be selected through `DEVNET_RUST_FIL_PROOFS_SOURCE`; its base commit and complete source hash are recorded in the image manifest. Never stage or commit files automatically.

After the reviewed pins have been fetched and the standard Curio base image exists:

```sh
just build-zigzag                  # CPU-only microbench; OpenCL-capable Curio
just build-zigzag-gpu              # CUDA microbench and CUDA Curio, sequentially
```

`just build` retains its existing default variants. CUDA builds use CUDA 12.8.1 pinned by image digest and Nsight Systems 2026.3.2 pinned by package SHA-256, alongside the pinned Rust/Go toolchain images. No host CUDA toolkit is required. The default CUDA architecture is SM 120 with matching PTX for RTX 5090; set `DEVNET_ZIGZAG_CUDA_ARCH` explicitly for another supported device. This is not a universal fatbin. The supported override values are validated against the pinned toolkit.

Each image records the build backend, CUDA architecture, source/overlay hashes and a Cargo feature graph with the actual unified feature sets at `/usr/local/share/zigzag/cargo-features.txt`. FFI explicitly selects `cuda-no-fvm` or `opencl-no-fvm` when FVM is disabled; a missing `nvcc` is an error for a requested CUDA build. CUDA and OpenCL use separate build variants because Cargo features unify across aliases inside a binary. SupraSeal remains disabled.

The CUDA Curio builder uses the pinned Rust image's Bookworm base and copies the pinned Go toolchain into it. This keeps GCC/glibc in CUDA 12.8's supported range and avoids the Trixie `sinpi/cospi` header conflict observed during validation. CUDA and other Curio variants also use separate compilation caches. See NVIDIA's [CUDA 12.8 Linux support matrix](https://docs.nvidia.com/cuda/archive/12.8.0/cuda-installation-guide-linux/index.html).

Manifests under `.runtime/devnet/build`:

| Artifact | CPU | CUDA | OpenCL |
| --- | --- | --- | --- |
| Microbench | `zigzag-microbench-images.json` | `zigzag-microbench-cuda-images.json` | `zigzag-microbench-opencl-images.json` |
| Curio | `zigzag-curio-cpu-images.json` | `zigzag-curio-cuda-images.json` | `zigzag-curio-images.json` |

For OpenCL, use `DEVNET_ZIGZAG_GPU_BACKEND=opencl just build-zigzag`. The device must have a working OpenCL ICD inside the NVIDIA container. OpenCL execution is not accepted by the CUDA trace checker; it remains an explicitly unverified alternative until a corresponding execution trace is collected. The current dedicated worker admission supports one NVIDIA device, not general multi-vendor OpenCL deployment.

## Three full-benchmark controls

Run these only after repairing the remote machine's driver and confirming sufficient host RAM. Set the selected device UUID once; do not use `all`. The commands use the same full `bench-zigzag-512`, existing parameter cache/VK, compact loader, batch 1 and default **50 GiB base RAM plus requested query cache, with no additional swap**. Prewarm uses the base budget only. The shared preset now defaults to 10 GiB query cache, giving a 60 GiB measured-container limit, encode prehash and binary TreeR with stream snapshots. `just bench-zigzag-32g` uses the same preset and GPU selection for native 32 GiB sectors. Preserve the same query cache, PC1 options and CPU pool sizes for every comparison.

```sh
export BENCH_ZIGZAG_GPU_DEVICE="GPU-<selected-device-uuid>"

# 1. CPU-only build.
BENCH_ZIGZAG_GPU_BUILD=cpu BENCH_ZIGZAG_GPU_BACKEND=cpu \
  just bench-zigzag-512

# 2. CUDA-capable build, Bellperson GPU explicitly disabled before startup.
BENCH_ZIGZAG_GPU_BUILD=cuda BENCH_ZIGZAG_GPU_BACKEND=cpu \
  BENCH_ZIGZAG_GPU_TRACE=1 just bench-zigzag-512

# 3. Same CUDA build, actual FFT and MSM execution required.
BENCH_ZIGZAG_GPU_BUILD=cuda BENCH_ZIGZAG_GPU_BACKEND=cuda \
  just bench-zigzag-512
```

The runtime defaults to the selected image backend. CUDA defaults to `BENCH_ZIGZAG_REQUIRE_GPU=1` and tracing for a full run. GPU-capable CPU controls also receive the selected device so the binary can resolve its CUDA driver dependency; `BELLMAN_NO_GPU=1` prevents proving on it. The harness always disables GPU for the separate parameter prewarm, including when the measured full run uses CUDA. Non-full modes do not claim GPU acceptance.

The pinned library selects its framework with **`EC_GPU_FRAMEWORK`**, not `BELLMAN_GPU_FRAMEWORK`. The helper sets `EC_GPU_FRAMEWORK=cuda` or `opencl`, `BELLMAN_NO_GPU`, and `BELLMAN_CPU_UTILIZATION` before the process starts. `BENCH_ZIGZAG_GPU_CPU_UTILIZATION` accepts a fraction from 0 to 1; required GPU execution rejects 1. Keep the initial fraction at 0. Tune `BENCH_RAYON_NUM_THREADS` and `BENCH_EC_GPU_NUM_THREADS` independently, then test batch 2 explicitly; do not infer that a CPU-optimal query cache or pool setting remains optimal on GPU.

## Execution evidence and reports

`gpu-request.json` records the effective build/runtime configuration even when the trace is unavailable. CUDA tracing wraps the full benchmark with Nsight Systems, keeps profiler output separate from benchmark JSON, and exports `cuda-trace.nsys-rep` to SQLite. `gpu-summary.json`, `report.json` and Markdown record:

- Completed `radix_fft` and `multiexp` kernel counts and durations, CUDA transfers and driver initialization/module-load calls.
- Device identity, profiler version, sampled whole-device VRAM peak, and explicit trace/correctness/fallback status. Device samples include other processes; VRAM is separate from host RAM and is not added to its budget.
- Existing phase CPU/RAM/time and C2 batch timers. Kernel, transfer and initialization intervals can overlap and must not be added to C2 wall time. Profiling overhead is included in the full run.

The exporter reads CUPTI activity tables described in the [Nsight Systems analysis guide](https://docs.nvidia.com/nsight-systems/AnalysisGuide/index.html); a real trace from this pinned profiler still needs runtime validation.

Required GPU mode fails if either kernel family is absent, profiling/export fails, the benchmark fails CPU proof verification or unseal correctness, or a known Bellperson fallback is logged. It does **not** claim that every operation in every batch ran exclusively on the GPU: upstream has silent initialization failure paths and intentionally retains CPU work, including synthesis. A device inventory, kernel-instantiation message or VRAM allocation alone never establishes execution. CPU control tracing rejects any CUDA kernel activity. A profiler failure remains a failed GPU measurement even if a proof was produced successfully.

CUDA fatbins are compiled during the image build. Device/context and driver module initialization can recur when Bellperson creates kernels. The first C2 batch and later batches remain separately timed; this is not yet a measurement of a persistent warm Curio worker. Before claiming a speedup, compare full C2 and sealing, verify the same parameter ID/VK and proof format, and measure cold and warm worker behavior. The initial profiled comparison is diagnostic; any later unprofiled timing must explicitly disable required evidence and be labelled accordingly.

## Curio admission and shared locks

For an explicitly selected GPU worker:

```sh
DEVNET_ZIGZAG_CURIO_GPU_BACKEND=cuda \
DEVNET_ZIGZAG_GPU_DEVICE="GPU-<selected-device-uuid>" \
  just up zigzag 512mib
```

This selects the CUDA Curio manifest and adds the GPU Compose override. The default dedicated Curio runtime is CPU (`BELLMAN_NO_GPU=1`), even though its historical default image can compile OpenCL. No opportunistic GPU use is allowed in a worker whose scheduler reserves zero GPUs. Reuse the explicit GPU selection when regenerating the Compose environment; omitting it selects CPU again.

The CUDA-build CPU control is provided by the benchmark harness. Curio's CUDA image requires the explicit GPU worker configuration to supply its driver libraries; selecting that image in the CPU-only Compose configuration is rejected before startup.

The launcher checks that exactly one device is visible and registers one GPU with Harmony. ZigZag C2 reserves that whole device (`Cost.Gpu=1`, at most one C2), including its VRAM, rather than treating VRAM as host RAM. Large-sector host admission is capped at 60 GiB and Compose enforces the same memory/swap limit. Small-sector reservations remain smaller. This is an admission policy pending runtime acceptance, not a measured guarantee for CUDA's memory footprint.

`DEVNET_GPU_LOCK_DIR` defaults to the project's `.runtime/gpu-locks` and is mounted at `/var/tmp/filecoin-gpu-locks`. The host prepares it with group inheritance (`2770`); GPU launchers use umask `0002`, so the root Curio container and host-user benchmark can reopen the same lock files. Rust holds a device-specific ZigZag admission lock across all C2 batches. Bellperson retains its existing **blocking global lock and PoSt priority protocol** in the shared `TMPDIR`; the per-device try-lock mode is intentionally rejected. Other participating Bellperson workers must use the same shared directory, compatible ownership/group and global-lock mode to coordinate across containers. The C2 admission lock does not block the priority lock or change the priority passed to Bellperson.

Harmony accounts for this worker's tasks; it cannot reserve VRAM against unrelated host applications. The initial deployment therefore permits one heavy user of the device. GPU TreeR is still absent, so no Neptune GPU work is introduced here. Bellperson's ec-gpu-gen 0.7.1 and Neptune's 0.6.0 must not be assumed to share locking; the next GPU TreeR implementation must join the explicit device admission protocol.

The dedicated Curio `ffiselect` override preserves the shared `TMPDIR` when starting GPU FFI subprocesses. Upstream otherwise creates a separate temporary directory for every call, which would split Bellperson's GPU and priority locks. Private-directory cleanup is retained, and CPU/SDR calls retain the upstream temporary-directory behavior. The OpenCL build also preserves Curio's `build.IsOpencl` metadata so its child process receives the correct device-ordinal variable.

## Validation

Configuration/report tests, synthetic CUDA trace tests and TypeScript contract checks cover CPU controls, rejected settings, incomplete traces, fallback, correctness failures, and the required single-device/memory/mount contract. They do not execute cryptographic GPU kernels.

The small harness checks can be repeated with `npm --prefix tools run test:gpu-settings` (Node.js and Python 3). Rust and Go tests are run on the remote machine. The isolated Go tests compile only `zigzag_gpu.go` and `zigzag_gpu_test.go`, so they validate FFI environment selection without loading the FFI library or a GPU driver.

Validation completed on 15 October 2026:

- Remote release builds passed for CPU-only microbench, CUDA microbench, default OpenCL Curio and CUDA Curio. CUDA targets SM 120. The feature graph confirms native Bellperson 0.27.0 and ec-gpu-gen 0.7.1 with CUDA enabled; no SupraSeal is selected.
- 55 configuration/report tests passed: 34 JavaScript, 8 synthetic SQLite trace, 2 TypeScript GPU contract, 5 mocked runner/lifecycle regressions, 3 remote Rust CPU configuration and 3 remote Go FFI environment tests. TypeScript checking, shell syntax and formatting checks passed. No real benchmark is invoked by the mocked runner tests.
- Actual Docker Compose rendering passed the typed GPU/device/memory/mount contract. Small CPU-only containers confirmed that root and the host user can reopen the same group-writable lock files. No Curio service or GPU kernel was started.
- All four final manifests match the local Rust source digest `05b981b287d12fe0d2dc64be5f7c8d017ead0458cdc5817d064ed5f39b55b8ff`, their respective current overlay digests and Dockerfiles. Builds used an isolated source copy based on the existing Rust commit, without changing pins or the main remote checkout.

The workspace-local, uncommitted [validation record](../../.runtime/remote-builds/zigzag-gpu-groth16-20261015/validation.json) contains image IDs, manifests, feature-graph digests and test scope. GPU proof correctness, existing-VK interoperability, VRAM peak, cold/warm C2 speed and full 512 MiB/32 GiB acceptance remain deferred. No GPU benchmark has been run as part of this change.
