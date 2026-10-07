#!/usr/bin/env bash
# Validate settings on the host, resolve "auto" only inside the container's cpuset.
# This helper is sourced only for the dedicated ZigZag process.

zigzag_cpu_setting() {
  local label="$1" value="$2" minimum="$3" maximum="$4"
  if [[ "${value}" == auto && "${minimum}" == auto ]]; then
    printf '%s\n' "${value}"
    return
  fi
  [[ "${value}" =~ ^[0-9]{1,9}$ ]] || devnet_die "${label} must be an integer (thread pools also accept auto)"
  value=$((10#${value}))
  [[ "${minimum}" != auto ]] || minimum=1
  ((value >= minimum && value <= maximum)) || devnet_die "${label} must be between ${minimum} and ${maximum}"
  printf '%s\n' "${value}"
}

zigzag_cpu_bool() {
  case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) printf '1\n' ;;
    0|false|no|off) printf '0\n' ;;
    *) devnet_die "${1} must be a boolean" ;;
  esac
}

zigzag_emit_integer() {
  local name="$1" value
  shift
  value="$(zigzag_cpu_setting "${name}" "$@")" || return
  printf '%s=%s\n' "${name}" "${value}"
}

zigzag_bench_cpu_environment() {
  local name value
  zigzag_emit_integer RAYON_NUM_THREADS "${BENCH_RAYON_NUM_THREADS:-${RAYON_NUM_THREADS:-auto}}" auto 4096 || return
  zigzag_emit_integer EC_GPU_NUM_THREADS "${BENCH_EC_GPU_NUM_THREADS:-${EC_GPU_NUM_THREADS:-auto}}" auto 4096 || return
  for name in USE_PARENT_CACHE MULTICORE_ENCODE ENCODE_AFFINITY PARENT_CACHE_DONTNEED TREE_R_DONTNEED; do
    case "${name}" in
      USE_PARENT_CACHE) value="${BENCH_ZIGZAG_USE_PARENT_CACHE:-${FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE:-1}}"; name=USE_ZIGZAG_PARENT_CACHE ;;
      MULTICORE_ENCODE) value="${BENCH_ZIGZAG_MULTICORE_ENCODE:-${FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE:-1}}"; name=ZIGZAG_MULTICORE_ENCODE ;;
      ENCODE_AFFINITY) value="${BENCH_ZIGZAG_ENCODE_AFFINITY:-${FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_AFFINITY:-1}}"; name=ZIGZAG_MULTICORE_ENCODE_AFFINITY ;;
      PARENT_CACHE_DONTNEED) value="${BENCH_ZIGZAG_PARENT_CACHE_DONTNEED:-${FIL_PROOFS_ZIGZAG_PARENT_CACHE_DONTNEED:-0}}"; name=ZIGZAG_PARENT_CACHE_DONTNEED ;;
      TREE_R_DONTNEED) value="${BENCH_ZIGZAG_TREE_R_DONTNEED:-${FIL_PROOFS_ZIGZAG_TREE_R_DONTNEED:-0}}"; name=ZIGZAG_TREE_R_DONTNEED ;;
    esac
    value="$(zigzag_cpu_bool "${name}" "${value}")" || return
    printf 'FIL_PROOFS_%s=%s\n' "${name}" "${value}"
  done
  zigzag_emit_integer FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS "${BENCH_ZIGZAG_ENCODE_PRODUCERS:-${FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCERS:-2}}" 1 64 || return
  zigzag_emit_integer FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE "${BENCH_ZIGZAG_ENCODE_STRIDE:-${FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_PRODUCER_STRIDE:-128}}" 1 262144 || return
  zigzag_emit_integer FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD "${BENCH_ZIGZAG_ENCODE_LOOKAHEAD:-${FIL_PROOFS_ZIGZAG_MULTICORE_ENCODE_LOOKAHEAD:-4096}}" 1 262144 || return
  zigzag_emit_integer FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES "${BENCH_ZIGZAG_PARENT_BUFFER_NODES:-${FIL_PROOFS_ZIGZAG_PARENT_BUFFER_NODES:-0}}" 0 262144 || return
}
