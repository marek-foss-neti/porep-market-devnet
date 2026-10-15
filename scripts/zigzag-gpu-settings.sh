#!/usr/bin/env bash
# Dedicated ZigZag processes only. Never set these variables in the SDR image.
zigzag_gpu_environment() {
  local build="$1" backend="$2" required="$3" utilization
  case "${build}" in cpu|cuda|opencl) ;; *) devnet_die "invalid ZigZag GPU build: ${build}" ;; esac
  case "${backend}" in cpu|cuda|opencl) ;; *) devnet_die "ZigZag GPU backend must be cpu, cuda or opencl" ;; esac
  case "${required}" in 0|1) ;; *) devnet_die "BENCH_ZIGZAG_REQUIRE_GPU must be 0 or 1" ;; esac
  [[ "${backend}" == cpu || "${backend}" == "${build}" ]] || devnet_die "requested GPU backend is absent from selected image"
  [[ "${required}" == 0 || "${backend}" == cuda ]] || devnet_die "required GPU execution currently requires CUDA with an Nsight trace"
  [[ -z "${BELLMAN_GPU_FRAMEWORK:-}" ]] || devnet_die "this lock uses EC_GPU_FRAMEWORK, not BELLMAN_GPU_FRAMEWORK"
  utilization="${BENCH_ZIGZAG_GPU_CPU_UTILIZATION-${BELLMAN_CPU_UTILIZATION-0}}"
  [[ "${utilization}" =~ ^(0([.][0-9]+)?|1([.]0+)?)$ ]] || devnet_die "GPU CPU utilization must be a finite fraction between 0 and 1"
  [[ "${required}" == 0 || ! "${utilization}" =~ ^1([.]0+)?$ ]] || devnet_die "required GPU MSM conflicts with 100% CPU utilization"
  printf 'FIL_PROOFS_ZIGZAG_GPU_BACKEND=%s\n' "${backend}"
  printf 'BELLMAN_CPU_UTILIZATION=%s\n' "${utilization}"
  # Keep Bellperson's blocking global lock and its PoSt priority protocol.
  # Per-device try-lock mode is a different namespace and cannot coordinate
  # with workers using the upstream default lock.
  [[ -z "${BELLPERSON_GPUS_PER_LOCK+x}" ]] || devnet_die "dedicated ZigZag workers require the default Bellperson global lock; unset BELLPERSON_GPUS_PER_LOCK"
  if [[ "${backend}" == cpu ]]; then
    printf 'BELLMAN_NO_GPU=1\n'
  else
    printf 'BELLMAN_NO_GPU=0\nEC_GPU_FRAMEWORK=%s\n' "${backend}"
    printf 'FIL_PROOFS_ZIGZAG_GPU_LOCK_DIR=/var/tmp/filecoin-gpu-locks\n'
    printf 'TMPDIR=/var/tmp/filecoin-gpu-locks\n'
  fi
}
