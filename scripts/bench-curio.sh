#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

for command in docker node jq; do devnet_require_command "${command}"; done
sector_size="${1:-32gib}"
case "${sector_size}" in
  32gib) sector_bytes=34359738368 ;;
  8mib) sector_bytes=8388608 ;;
  *) devnet_die "Curio offline benchmark supports 32gib, or 8mib for smoke tests" ;;
esac
positive_integer() {
  [[ "$2" =~ ^[1-9][0-9]{0,14}$ ]] || devnet_die "$1 must be a positive integer"
}
interval="${BENCH_TELEMETRY_INTERVAL_MS:-500}"
positive_integer BENCH_TELEMETRY_INTERVAL_MS "${interval}"
((interval >= 100 && interval <= 60000)) || devnet_die "telemetry interval must be 100..60000ms"
timeout="${BENCH_CURIO_TIMEOUT_SECONDS:-86400}"
fetch_timeout="${BENCH_CURIO_FETCH_TIMEOUT_SECONDS:-14400}"
positive_integer BENCH_CURIO_TIMEOUT_SECONDS "${timeout}"
positive_integer BENCH_CURIO_FETCH_TIMEOUT_SECONDS "${fetch_timeout}"
retain="${BENCH_CURIO_RETAIN_WORK:-0}"
[[ "${retain}" == 0 || "${retain}" == 1 ]] || devnet_die "BENCH_CURIO_RETAIN_WORK must be 0 or 1"
memory="${BENCH_CURIO_MEMORY_BYTES:-0}"
cpus="${BENCH_CURIO_CPUS:-0}"
[[ "${memory}" == 0 ]] || positive_integer BENCH_CURIO_MEMORY_BYTES "${memory}"
[[ "${cpus}" == 0 ]] || positive_integer BENCH_CURIO_CPUS "${cpus}"
[[ "${cpus}" == 0 || "${cpus}" -ge 2 ]] || devnet_die "Curio native decode requires at least 2 CPUs"

# Same verified, pinned base image as the SDR microbenchmark, with an additional
# executable. No active deployment, compose environment, or backend switch.
image="$(devnet_proof_microbench_image_for_backend stacked)"
docker run --rm --network none --entrypoint curio-bench "${image}" test bench-seal-unseal --help >/dev/null ||
  devnet_die "image lacks the offline Curio benchmark; run just build"
docker_info="$(docker info --format '{{json .}}')"
docker_cpus="$(jq -r '.NCPU' <<<"${docker_info}")"
docker_memory="$(jq -r '.MemTotal' <<<"${docker_info}")"
((docker_cpus >= 2)) || devnet_die "Curio native decode requires at least 2 Docker CPUs"
((cpus <= docker_cpus)) || devnet_die "BENCH_CURIO_CPUS exceeds Docker CPU capacity"
((memory <= docker_memory)) || devnet_die "BENCH_CURIO_MEMORY_BYTES exceeds Docker RAM capacity"

timestamp="$(node -e 'process.stdout.write(new Date().toISOString().replace(/[:.]/g,"-"))')"
run_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-bench-curio-${sector_size}"
devnet_require_safe_write_path "${run_dir}" directory
mkdir -p "${DEVNET_ROOT}/.runtime/runs"
mkdir "${run_dir}"
parameter_cache="${BENCH_PROOF_PARAMETERS_DIR:-${DEVNET_PROOF_PARAMETERS_DIR}}"
parent_cache="${BENCH_STACKED_PARENT_CACHE_DIR:-$(devnet_parent_cache_dir_for_backend stacked)}"
for path in "${parameter_cache}" "${parent_cache}"; do
  [[ "${path}" == /* && "${path}" != *','* ]] || devnet_die "benchmark cache paths must be absolute and contain no commas"
  if [[ "${path}" == "${DEVNET_ROOT}/"* ]]; then devnet_require_safe_write_path "${path}" directory; fi
  mkdir -p "${path}"
done
[[ "${run_dir}" != *','* ]] || devnet_die "repository path must not contain commas"
window="$(devnet_parent_cache_window_nodes)"
common=(--init --user "$(id -u):$(id -g)" --cgroupns private --oom-score-adj 1000
  --mount "type=bind,src=${run_dir},dst=/bench-run"
  --mount "type=bind,src=${parameter_cache},dst=/var/tmp/filecoin-proof-parameters"
  --mount "type=bind,src=${parent_cache},dst=/var/tmp/filecoin-parents"
  -e HOME=/tmp -e TMPDIR=/tmp -e RUST_LOG=info
  -e FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters
  -e FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents
  -e "FIL_PROOFS_SDR_PARENTS_CACHE_SIZE=${window}"
  -e FIL_PROOFS_USE_ZIGZAG=0 -e FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=0
  -e FIL_PROOFS_USE_MULTICORE_SDR=1
  -e FIL_PROOFS_USE_GPU_COLUMN_BUILDER=0 -e FIL_PROOFS_USE_GPU_TREE_BUILDER=0
  -e BELLMAN_NO_GPU=1 -e NVIDIA_VISIBLE_DEVICES=void)
limits=()
if ((memory > 0)); then limits+=(--memory "${memory}" --memory-swap "${memory}"); fi
if ((cpus > 0)); then limits+=(--cpus "${cpus}" -e "RAYON_NUM_THREADS=${cpus}" -e "GOMAXPROCS=${cpus}"); fi

# Check the filesystem as Docker sees it, including Docker Desktop bind mounts.
# This is a capacity check, not a reservation or a prediction of peak disk use.
free_bytes="$(docker run --rm --network none "${common[@]}" --entrypoint sh "${image}" -c 'df -Pk /bench-run | awk "NR==2 {printf \"%.0f\", \$4*1024}"')"
[[ "${free_bytes}" =~ ^[0-9]+$ ]] || devnet_die "could not determine free scratch capacity"
minimum_free=$((sector_bytes * 22))
((free_bytes >= minimum_free)) || devnet_die "offline Curio benchmark needs at least ${minimum_free} bytes free on its scratch filesystem; found ${free_bytes}"

cp "${DEVNET_BUILD_DIR}/images.json" "${run_dir}/build-manifest.json"
node "${DEVNET_ROOT}/scripts/curio-bench-report.mjs" init "${run_dir}" "${sector_bytes}" "${image}" "${memory}" "${cpus}" "${interval}" "${window}" "${retain}" "${parameter_cache}" "${parent_cache}"
container=""
running_pid=""
phase="setup"
finish() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "${container}" ]]; then
    docker stop --time 10 "${container}" >/dev/null 2>&1 || true
    docker inspect --format '{{json .State}}' "${container}" >"${run_dir}/${phase}-container.json" 2>/dev/null || true
    docker rm "${container}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${running_pid}" ]]; then wait "${running_pid}" 2>/dev/null || true; fi
  node "${DEVNET_ROOT}/scripts/curio-bench-report.mjs" finish "${run_dir}" "${code}" "${phase}" || code=1
  if ((code == 0)) && [[ "${retain}" == 0 ]]; then
    # Only the fresh work directory owned by this run. No shared cache/pruning.
    rm -rf -- "${run_dir}/work"
  fi
  printf 'Curio offline benchmark: %s/summary.md\n' "${run_dir}"
  exit "${code}"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_container() {
  local budget="$1"; shift
  local start="${SECONDS}" last="${SECONDS}" code actual
  # Bash 3 (macOS) treats empty arrays as unset with nounset enabled.
  container="$(docker create "${common[@]}" ${limits[@]+"${limits[@]}"} "$@" --entrypoint curio-bench "${image}" \
    test bench-seal-unseal --run-dir /bench-run --sector-size "${sector_bytes}" --sample-interval "${interval}ms" ${extra_args[@]+"${extra_args[@]}"})"
  printf '%s\n' "${container}" >"${run_dir}/${phase}.cid"
  docker start -a "${container}" >"${run_dir}/${phase}.stdout.log" 2>"${run_dir}/${phase}.stderr.log" &
  running_pid=$!
  while kill -0 "${running_pid}" 2>/dev/null; do
    if ((SECONDS-start >= budget)); then devnet_progress "Curio ${phase} exceeded timeout"; return 124; fi
    if ((SECONDS-last >= 30)); then
      devnet_progress "Curio ${phase}: $(devnet_format_duration_seconds "$((SECONDS-start))"); $(tail -c 2048 "${run_dir}/${phase}.stderr.log" | tr '\r' '\n' | tail -n 1 | cut -c1-240)"
      last="${SECONDS}"
    fi
    sleep 2
  done
  code=0
  wait "${running_pid}" || code=$?
  running_pid=""
  docker inspect --format '{{json .State}}' "${container}" >"${run_dir}/${phase}-container.json"
  # docker start -a can succeed even if the container command failed.
  actual="$(jq -r '.ExitCode' "${run_dir}/${phase}-container.json")"
  if ((actual != 0)); then code="${actual}"; fi
  docker rm "${container}" >/dev/null
  container=""
  return "${code}"
}

phase=parameters
extra_args=(--fetch-params-only)
devnet_progress "Curio: fetching/verifying official SDR PoRep parameters for ${sector_size}"
run_container "${fetch_timeout}"
phase=benchmark
extra_args=()
devnet_progress "Curio: starting offline CPU ${sector_size} seal/unseal; reports=${run_dir}"
run_container "${timeout}" --network none
