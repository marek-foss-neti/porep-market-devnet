#!/usr/bin/env bash
set -euo pipefail
devnet_die() { printf 'ZigZag worker configuration: %s\n' "$*" >&2; exit 1; }
source "${0%/*}/../share/zigzag/cpu-settings.sh"
source "${0%/*}/../share/zigzag/gpu-settings.sh"
gpu_backend="${FIL_PROOFS_ZIGZAG_GPU_BACKEND-cpu}"
gpu_configuration="$(zigzag_gpu_environment "${ZIGZAG_COMPILED_GPU_BACKEND-opencl}" "${gpu_backend}" 0)"
while IFS= read -r setting; do export "${setting}"; done <<<"${gpu_configuration}"
if [[ "${gpu_backend}" != cpu ]]; then
  umask 0002
  [[ -d /var/tmp/filecoin-gpu-locks && -w /var/tmp/filecoin-gpu-locks ]] || devnet_die "shared GPU lock directory must be mounted writable"
  # Reserve the only visible device in Harmony; Rust checks the same visibility at C2.
  command -v nvidia-smi >/dev/null || devnet_die "GPU worker requires NVIDIA device passthrough"
  devices="$(nvidia-smi --query-gpu=uuid --format=csv,noheader)" || devnet_die "GPU driver unavailable"
  [[ "${devices}" == GPU-* && "${devices}" != *$'\n'* ]] || devnet_die "GPU worker requires exactly one visible device"
  [[ "${HARMONY_OVERRIDE_GPUS-1}" == 1 ]] || devnet_die "dedicated worker must reserve its one physical GPU"
  export HARMONY_OVERRIDE_GPUS=1
fi
configuration="$(zigzag_bench_cpu_environment)"
while IFS= read -r setting; do export "${setting}"; done <<<"${configuration}"
# Runs before Go can call FFI or initialize a static Rayon/ec-gpu pool.
# nproc observes this process's affinity/cpuset; never use the host's old vCPU count.
threads="$(env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc)"
for name in RAYON_NUM_THREADS EC_GPU_NUM_THREADS; do
  value="${!name:-auto}"
  [[ "${value}" != auto ]] || value="${threads}"
  [[ "${value}" =~ ^[0-9]{1,4}$ ]] && ((10#${value} >= 1 && 10#${value} <= 4096)) || {
    printf 'invalid %s: %s\n' "${name}" "${value}" >&2
    exit 1
  }
  export "${name}=$((10#${value}))"
done
printf 'ZigZag pools: Rayon=%s ec-gpu=%s; allowed CPUs=%s\n' "${RAYON_NUM_THREADS}" "${EC_GPU_NUM_THREADS}" "${threads}" >&2
program="${0##*/}"
case "${program}" in curio|sptool) ;; *) printf 'unexpected ZigZag launcher name: %s\n' "${program}" >&2; exit 1 ;; esac
exec -a "${program}" "${0%/*}/${program}-zigzag" "$@"
