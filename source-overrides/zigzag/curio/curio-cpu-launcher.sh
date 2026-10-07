#!/usr/bin/env bash
set -euo pipefail
devnet_die() { printf 'ZigZag CPU configuration: %s\n' "$*" >&2; exit 1; }
source "${0%/*}/../share/zigzag/cpu-settings.sh"
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
