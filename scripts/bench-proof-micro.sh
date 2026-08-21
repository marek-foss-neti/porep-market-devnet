#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command jq

backend="$(devnet_normalize_proof_backend "${1:-${DEVNET_PROOF_BACKEND:-stacked}}")"
sector_size="${2:-${DEVNET_SECTOR_SIZE:-8mib}}"
sector_size="$(devnet_normalize_sector_size "${sector_size}")"
mode="${3:-full}"
case "${mode}" in
  full|prepare-fixture|unseal-only) ;;
  *) devnet_die "invalid proof microbench mode: ${mode}; expected full, prepare-fixture, or unseal-only" ;;
esac

microbench_layers="${BENCH_PROOF_MICRO_LAYERS:-${POREP_PROOF_MICROBENCH_LAYERS:-}}"
if [[ -z "${microbench_layers}" && "${mode}" == "full" && "${sector_size}" == "512mib" ]]; then
  microbench_layers="11"
fi
case "${microbench_layers}" in
  ""|2|11) ;;
  *) devnet_die "invalid proof microbench layer override: ${microbench_layers}; expected 2 or 11" ;;
esac

normalize_microbench_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${value}" in
    1|true|yes|on) printf '1\n' ;;
    0|false|no|off|'') printf '0\n' ;;
    *) devnet_die "invalid boolean value for Stacked multicore SDR: ${1}; expected 1/0, true/false, yes/no, or on/off" ;;
  esac
}

stacked_multicore_sdr_requested="0"
if [[ "${backend}" == "stacked" ]]; then
  stacked_multicore_sdr_requested="$(normalize_microbench_bool "${BENCH_STACKED_USE_MULTICORE_SDR:-${FIL_PROOFS_USE_MULTICORE_SDR:-1}}")"
fi
stacked_sdr_replication_mode="not-applicable"
if [[ "${backend}" == "stacked" ]]; then
  if [[ "${stacked_multicore_sdr_requested}" == "1" ]]; then
    stacked_sdr_replication_mode="multicore"
  else
    stacked_sdr_replication_mode="single-core"
  fi
fi

devnet_prepare_runtime

image_manifest="${DEVNET_BUILD_DIR}/images.json"
[[ -f "${image_manifest}" && ! -L "${image_manifest}" ]] ||
  devnet_die "image manifest is missing; run just build first"
curio_commit="$(jq -r '.curioCommit // empty' "${image_manifest}")"
[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "image manifest has no Curio commit"
manifest_dockerfile_sha256="$(jq -r '.dockerfileSha256 // empty' "${image_manifest}")"
manifest_zigzag_overrides_sha256="$(jq -r '.zigzagSourceOverridesSha256 // empty' "${image_manifest}")"
[[ "$(devnet_docker_surface_sha256)" == "${manifest_dockerfile_sha256}" ]] ||
  devnet_die "image manifest is stale for the current Docker/source surface; run just build"
[[ "$(devnet_zigzag_source_overrides_sha256)" == "${manifest_zigzag_overrides_sha256}" ]] ||
  devnet_die "image manifest is stale for the current ZigZag source overrides; run just build"
image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"
docker image inspect "${image}" >/dev/null || devnet_die "required image is missing: ${image}"
docker run --rm --entrypoint sh "${image}" -c 'command -v porep-proof-microbench >/dev/null 2>&1' ||
  devnet_die "image ${image} does not contain porep-proof-microbench; run just build"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
safe_sector="$(printf '%s' "${sector_size}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
run_name="bench-proof-micro-${backend}-${safe_sector}"
if [[ "${mode}" != "full" ]]; then
  run_name="${run_name}-${mode}"
fi
run_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-${run_name}"
devnet_require_safe_write_path "${DEVNET_ROOT}/.runtime/runs" directory
devnet_require_safe_write_path "${run_dir}" directory
mkdir -p "${run_dir}"

summary_json="${run_dir}/summary.json"
fixture_summary_json="${run_dir}/fixture-summary.json"
prewarm_summary_json="${run_dir}/param-prewarm.json"
fixture_stderr_log="${run_dir}/fixture.stderr.log"
prewarm_stderr_log="${run_dir}/param-prewarm.stderr.log"
stderr_log="${run_dir}/stderr.log"
unseal_cidfile="${run_dir}/unseal.cid"
work_dir="${run_dir}/work"
if [[ "${backend}" == "zigzag" ]]; then
  fixture_override="${BENCH_ZIGZAG_MICRO_FIXTURE_DIR:-${BENCH_MICRO_FIXTURE_DIR:-}}"
  parent_cache_override="${BENCH_ZIGZAG_PARENT_CACHE_DIR:-${BENCH_PARENT_CACHE_DIR:-}}"
else
  fixture_override="${BENCH_STACKED_MICRO_FIXTURE_DIR:-${BENCH_MICRO_FIXTURE_DIR:-}}"
  parent_cache_override="${BENCH_STACKED_PARENT_CACHE_DIR:-${BENCH_PARENT_CACHE_DIR:-}}"
fi
fixture_host="${4:-${fixture_override:-${DEVNET_ROOT}/.runtime/proof-micro-fixtures/${backend}-${safe_sector}-minimal-unseal}}"
parameter_cache_host="${DEVNET_PROOF_PARAMETERS_DIR}"
if [[ "${backend}" == "stacked" ]]; then
  parameter_cache_host="${run_dir}/stacked-proof-parameter-cache"
fi
if [[ -n "${BENCH_PROOF_PARAMETERS_DIR:-}" ]]; then
  parameter_cache_host="${BENCH_PROOF_PARAMETERS_DIR}"
fi
if [[ -n "${BENCH_PARENT_CACHE_WINDOW_NODES:-}" ]]; then
  DEVNET_PARENT_CACHE_WINDOW_NODES="${BENCH_PARENT_CACHE_WINDOW_NODES}"
fi
if [[ -n "${parent_cache_override}" ]]; then
  parent_cache_host="${parent_cache_override}"
else
  parent_cache_host="$(devnet_parent_cache_dir_for_backend "${backend}")"
fi
parent_cache_window_nodes="$(devnet_parent_cache_window_nodes)"
parent_cache_kind="${backend}"
if [[ "${backend}" == "zigzag" ]]; then
  parent_cache_kind="ZigZag"
elif [[ "${backend}" == "stacked" ]]; then
  parent_cache_kind="Stacked"
fi
if [[ "${parent_cache_host}" == "${DEVNET_ROOT}/"* ]]; then
  devnet_require_safe_write_path "${parent_cache_host}" directory
fi
mkdir -p "${parent_cache_host}"
docker_parent_cache_args=(
  -e "FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents"
  -e "FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=$(devnet_fil_proofs_use_zigzag "${backend}")"
  -e "FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE=${parent_cache_window_nodes}"
  -e "FIL_PROOFS_SDR_PARENTS_CACHE_SIZE=${parent_cache_window_nodes}"
  -v "${parent_cache_host}:/var/tmp/filecoin-parents:rw"
)
mkdir -p "${work_dir}"
mkdir -p "${parameter_cache_host}"
mkdir -p "${fixture_host}"

docker_common_args=(
  --user "$(id -u):$(id -g)"
  -e "FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters"
  -e "FIL_PROOFS_USE_ZIGZAG=$(devnet_fil_proofs_use_zigzag "${backend}")"
  -e "FIL_PROOFS_USE_MULTICORE_SDR=${stacked_multicore_sdr_requested}"
  -e "FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/tmp/filecoin-zigzag-proof-sidecars"
  -e "POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=${POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS:-0}"
  -e "POREP_PROOF_MICROBENCH_LAYERS=${microbench_layers}"
  -v "${parameter_cache_host}:/var/tmp/filecoin-proof-parameters:rw"
  -v "${run_dir}:/bench-run:rw"
  "${docker_parent_cache_args[@]}"
)

bench_fixture_size_label() {
  local fixture_dir="$1"
  local kib
  kib="$(du -sk "${fixture_dir}" 2>/dev/null | awk 'NR == 1 {print $1}')"
  if [[ -z "${kib}" ]]; then
    printf 'unavailable\n'
  else
    devnet_format_bytes "$((kib * 1024))"
  fi
}

bench_file_size_label() {
  local path="$1"
  local bytes
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    printf 'missing\n'
    return 0
  fi
  bytes="$(wc -c < "${path}" 2>/dev/null | tr -d '[:space:]')"
  if [[ "${bytes}" =~ ^[0-9]+$ ]]; then
    devnet_format_bytes "${bytes}"
  else
    printf 'unavailable\n'
  fi
}

bench_container_status_label() {
  local cidfile="$1"
  local cid status exit_code oom
  if [[ ! -f "${cidfile}" || -L "${cidfile}" ]]; then
    printf 'container=pending\n'
    return 0
  fi
  IFS= read -r cid < "${cidfile}" || true
  if [[ -z "${cid}" ]]; then
    printf 'container=pending\n'
    return 0
  fi
  status="$(docker inspect --format '{{.State.Status}}' "${cid}" 2>/dev/null || true)"
  if [[ -z "${status}" ]]; then
    printf 'container=gone\n'
    return 0
  fi
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${cid}" 2>/dev/null || true)"
  oom="$(docker inspect --format '{{.State.OOMKilled}}' "${cid}" 2>/dev/null || true)"
  printf 'container=%s exit=%s oom=%s\n' "${status}" "${exit_code:-unknown}" "${oom:-unknown}"
}

bench_unseal_range_label() {
  local manifest="$1"
  local offset="${BENCH_UNSEAL_RANGE_OFFSET:-0}"
  local size="${BENCH_UNSEAL_RANGE_SIZE:-}"
  local unpadded
  if [[ -z "${size}" ]]; then
    unpadded="$(jq -r '.unpadded_bytes // empty' "${manifest}" 2>/dev/null || true)"
    if [[ "${offset}" =~ ^[0-9]+$ && "${unpadded}" =~ ^[0-9]+$ && "${unpadded}" -ge "${offset}" ]]; then
      size="$((unpadded - offset))"
    fi
  fi
  if [[ "${offset}" =~ ^[0-9]+$ && "${size}" =~ ^[0-9]+$ ]]; then
    printf '%s at offset %s\n' "$(devnet_format_bytes "${size}")" "$(devnet_format_bytes "${offset}")"
  else
    printf 'unknown\n'
  fi
}

bench_start_fixture_progress() {
  local result_variable="$1"
  local label="$2"
  local stderr_log="$3"
  local fixture_dir="$4"
  printf -v "${result_variable}" ''
  devnet_progress_enabled || return 0
  (
    interval="$(devnet_progress_interval_seconds)"
    started="${SECONDS}"
    while :; do
      sleep "${interval}"
      elapsed="$((SECONDS - started))"
      message="${label}: still running after $(devnet_format_duration_seconds "${elapsed}"); fixture=$(bench_fixture_size_label "${fixture_dir}")"
      last_line="$(devnet_last_nonempty_line "${stderr_log}")"
      [[ -z "${last_line}" ]] || message="${message}; last=${last_line}"
      devnet_progress "${message}"
    done
  ) >/dev/null &
  printf -v "${result_variable}" '%s' "$!"
}

bench_start_unseal_progress() {
  local result_variable="$1"
  local label="$2"
  local stderr_log="$3"
  local summary_log="$4"
  local cidfile="$5"
  printf -v "${result_variable}" ''
  devnet_progress_enabled || return 0
  (
    interval="$(devnet_progress_interval_seconds)"
    started="${SECONDS}"
    while :; do
      sleep "${interval}"
      elapsed="$((SECONDS - started))"
      message="${label}: still running after $(devnet_format_duration_seconds "${elapsed}"); $(bench_container_status_label "${cidfile}"); summary=$(bench_file_size_label "${summary_log}")"
      last_line="$(devnet_last_nonempty_line "${stderr_log}")"
      [[ -z "${last_line}" ]] || message="${message}; last=${last_line}"
      devnet_progress "${message}"
    done
  ) >/dev/null &
  printf -v "${result_variable}" '%s' "$!"
}

run_prepare_fixture() {
  local output_json="$1"
  local output_stderr="$2"
  local fixture_pid fixture_progress_pid status
  devnet_progress "bench-proof-micro: preparing ${backend} ${sector_size} unseal fixture at ${fixture_host}"
  docker run --rm \
    "${docker_common_args[@]}" \
    -v "${fixture_host}:/bench-fixture:rw" \
    "${image}" \
    porep-proof-microbench \
      --backend "${backend}" \
      --sector-size "${sector_size}" \
      --work-dir /bench-fixture \
      --prepare-fixture \
    > "${output_json}" 2> "${output_stderr}" &
  fixture_pid="$!"
  fixture_progress_pid=""
  bench_start_fixture_progress \
    fixture_progress_pid \
    "bench-proof-micro: ${backend} ${sector_size} unseal fixture preparation" \
    "${output_stderr}" \
    "${fixture_host}"
  if wait "${fixture_pid}"; then
    devnet_stop_prewarm_progress "${fixture_progress_pid}"
    devnet_progress "bench-proof-micro: ${backend} ${sector_size} unseal fixture preparation complete; summary=${output_json}"
    return 0
  else
    status=$?
    devnet_stop_prewarm_progress "${fixture_progress_pid}"
    return "${status}"
  fi
}

run_unseal_only_benchmark() {
  local status unseal_pid unseal_progress_pid range_label
  range_label="$(bench_unseal_range_label "${fixture_host}/fixture.json")"
  rm -f -- "${unseal_cidfile}"
  devnet_progress "bench-proof-micro: starting measured ${backend} ${sector_size} unseal-only benchmark; range=${range_label}; fixture=${fixture_host}; summary=${summary_json}"
  if [[ "${backend}" == "zigzag" ]]; then
    devnet_progress "bench-proof-micro: ZigZag unseal-only decodes the full sealed sector before writing the requested range"
  fi
  docker run --rm \
    --cidfile "${unseal_cidfile}" \
    "${docker_common_args[@]}" \
    -v "${fixture_host}:/bench-fixture:rw" \
    "${image}" \
    porep-proof-microbench \
      --backend "${backend}" \
      --sector-size "${sector_size}" \
      --work-dir /bench-fixture \
      --unseal-only \
      ${range_args[@]+"${range_args[@]}"} \
    > "${summary_json}" 2> "${stderr_log}" &
  unseal_pid="$!"
  unseal_progress_pid=""
  bench_start_unseal_progress \
    unseal_progress_pid \
    "bench-proof-micro: ${backend} ${sector_size} measured unseal-only" \
    "${stderr_log}" \
    "${summary_json}" \
    "${unseal_cidfile}"
  if wait "${unseal_pid}"; then
    devnet_stop_prewarm_progress "${unseal_progress_pid}"
    devnet_progress "bench-proof-micro: ${backend} ${sector_size} measured unseal-only complete; summary=${summary_json}"
    return 0
  else
    status=$?
    devnet_stop_prewarm_progress "${unseal_progress_pid}"
    return "${status}"
  fi
}

range_args=()
if [[ -n "${BENCH_UNSEAL_RANGE_OFFSET:-}" ]]; then
  range_args+=(--range-offset "${BENCH_UNSEAL_RANGE_OFFSET}")
fi
if [[ -n "${BENCH_UNSEAL_RANGE_SIZE:-}" ]]; then
  range_args+=(--range-size "${BENCH_UNSEAL_RANGE_SIZE}")
fi

devnet_progress "bench-proof-micro: backend=${backend} sector_size=${sector_size} image=${image}"
if [[ -n "${microbench_layers}" ]]; then
  devnet_progress "bench-proof-micro: PoRep layers override=${microbench_layers}"
fi
if [[ "${backend}" == "stacked" ]]; then
  devnet_progress "bench-proof-micro: using isolated Stacked parameter cache at ${parameter_cache_host}"
  devnet_progress "bench-proof-micro: Stacked SDR replication=${stacked_sdr_replication_mode} FIL_PROOFS_USE_MULTICORE_SDR=${stacked_multicore_sdr_requested}"
fi
devnet_progress "bench-proof-micro: using persistent ${parent_cache_kind} parent cache at ${parent_cache_host} window_nodes=${parent_cache_window_nodes}"

if [[ "${mode}" == "prepare-fixture" ]]; then
  if run_prepare_fixture "${fixture_summary_json}" "${fixture_stderr_log}"; then
    :
  else
    status=$?
    if [[ -s "${fixture_stderr_log}" ]]; then
      tail -40 "${fixture_stderr_log}" >&2
    fi
    devnet_die "proof microbench fixture preparation failed with exit code ${status}; see ${fixture_stderr_log}"
  fi
  jq -e '.fixture.backend != null and .fixture.fixture_kind == "minimal-unseal" and (.fixture.unpadded_bytes | tonumber) > 0' "${fixture_summary_json}" >/dev/null ||
    devnet_die "proof microbench fixture summary is invalid; see ${fixture_summary_json}"
  summary_md="${run_dir}/summary.md"
  {
    printf '# Proof microbenchmark fixture\n\n'
    jq -r \
      --arg fixtureHost "${fixture_host}" '
      def ms($value): ($value | tostring) + " ms";
      def bytes($raw):
        ($raw | tonumber? // null) as $bytes
        | if $bytes == null then ""
          elif $bytes < 1024 then (($bytes|round|tostring) + " B")
          elif $bytes < 1048576 then (((($bytes / 1024) * 10 | round) / 10 | tostring) + " KiB")
          elif $bytes < 1073741824 then (((($bytes / 1048576) * 10 | round) / 10 | tostring) + " MiB")
          else (((($bytes / 1073741824) * 10 | round) / 10 | tostring) + " GiB")
          end;
      [
        "| Field | Value |",
        "| --- | --- |",
        "| Mode | `" + .mode + "` |",
        "| Fixture kind | `" + (.fixture.fixture_kind // "unknown") + "` |",
        "| Backend | `" + .fixture.backend + "` |",
        "| Sector size | `" + (.fixture.sector_size_label | tostring) + "` / " + bytes(.fixture.sector_size_bytes) + " |",
        "| Fixture host directory | `" + $fixtureHost + "` |",
        "| Manifest | `" + .manifest_path + "` |",
        "| Sealed sector | `" + .fixture.sealed_path + "` |",
        "| Seal cache | `" + .fixture.cache_dir + "` |",
        "| Proof cache artifacts | `" + ((.fixture.proof_cache_artifacts // []) | join(", ")) + "` |",
        "| Unpadded bytes | " + bytes(.fixture.unpadded_bytes) + " |",
        "",
        "| Phase | Wall | CPU | Max RSS |",
        "| --- | ---: | ---: | ---: |"
      ][],
      (.phases[] | "| `" + .name + "` | " + ms(.wall_ms) + " | " + ms(.cpu_ms) + " | " + bytes(.max_rss_bytes) + " |"),
      "",
      "Full machine-readable summary: [`fixture-summary.json`](./fixture-summary.json)."
    ' "${fixture_summary_json}"
  } > "${summary_md}"
  printf 'proof microbenchmark fixture: %s\n' "${summary_md}"
  exit 0
fi

if [[ "${mode}" == "unseal-only" ]]; then
  if [[ ! -f "${fixture_host}/fixture.json" ]]; then
    devnet_progress "bench-proof-micro: fixture is missing; preparing it outside the measured unseal phase"
    if run_prepare_fixture "${fixture_summary_json}" "${fixture_stderr_log}"; then
      :
    else
      status=$?
      if [[ -s "${fixture_stderr_log}" ]]; then
        tail -40 "${fixture_stderr_log}" >&2
      fi
      devnet_die "proof microbench fixture preparation failed with exit code ${status}; see ${fixture_stderr_log}"
    fi
  else
    if ! jq -e '.fixture_kind == "minimal-unseal"' "${fixture_host}/fixture.json" >/dev/null; then
      devnet_die "existing fixture at ${fixture_host} is not a minimal-unseal fixture; choose an empty fixture directory or recreate it with just bench-proof-micro-prepare-fixture"
    fi
    devnet_progress "bench-proof-micro: reusing ${backend} ${sector_size} unseal fixture at ${fixture_host}"
  fi

  if run_unseal_only_benchmark; then
    :
  else
    status=$?
    if [[ -s "${stderr_log}" ]]; then
      tail -40 "${stderr_log}" >&2
    fi
    devnet_die "proof microbench unseal-only failed with exit code ${status}; see ${stderr_log}"
  fi

  jq -e '.proof_parameter_cache_skipped == true and .raw_unseal_bytes_match == true' "${summary_json}" >/dev/null ||
    devnet_die "proof microbench unseal-only correctness failed; see ${summary_json}"

  summary_md="${run_dir}/summary.md"
  {
    printf '# Proof raw unseal/retrieval microbenchmark\n\n'
    jq -r \
      --arg fixtureHost "${fixture_host}" \
      --arg parentCacheHost "${parent_cache_host}" \
      --arg parentCacheWindowNodes "${parent_cache_window_nodes}" '
      def ms($value): ($value | tostring) + " ms";
      def bytes($raw):
        ($raw | tonumber? // null) as $bytes
        | if $bytes == null then ""
          elif $bytes < 1024 then (($bytes|round|tostring) + " B")
          elif $bytes < 1048576 then (((($bytes / 1024) * 10 | round) / 10 | tostring) + " KiB")
          elif $bytes < 1073741824 then (((($bytes / 1048576) * 10 | round) / 10 | tostring) + " MiB")
          else (((($bytes / 1073741824) * 10 | round) / 10 | tostring) + " GiB")
          end;
      [
        "| Field | Value |",
        "| --- | --- |",
        "| Mode | `" + .mode + "` |",
        "| Fixture kind | `" + (.fixture_kind // "unknown") + "` |",
        "| Backend | `" + .backend + "` |",
        "| Sector size | `" + (.sector_size_label | tostring) + "` / " + bytes(.sector_size_bytes) + " |",
        "| Registered seal proof | `" + .registered_seal_proof + "` (`" + (.registered_seal_proof_id | tostring) + "`) |",
        "| Unseal path | `" + .unseal_path + "` |",
        "| Proof parameter cache skipped | `" + (.proof_parameter_cache_skipped | tostring) + "` |",
        "| Fixture host directory | `" + $fixtureHost + "` |",
        "| Fixture manifest | `" + .fixture_manifest_path + "` |",
        "| Sealed sector | `" + .sealed_path + "` |",
        "| Seal cache | `" + .cache_dir + "` |",
        "| Proof cache artifacts | `" + ((.proof_cache_artifacts // []) | join(", ")) + "` |",
        "| Parent cache | `" + (.parent_cache // $parentCacheHost) + "` |",
        "| Parent cache window nodes | `" + ((.parent_cache_window_nodes // $parentCacheWindowNodes) | tostring) + "` |",
        "| Range offset | " + bytes(.range_offset) + " |",
        "| Range size | " + bytes(.range_size) + " |",
        "| Unsealed bytes | " + bytes(.unsealed_bytes) + " |",
        "| Raw unseal bytes match | `" + (.raw_unseal_bytes_match | tostring) + "` |",
        "| Mismatch at | `" + ((.mismatch_at // "none") | tostring) + "` |",
        "| Throughput | `" + ((.throughput_mib_per_s // 0) | tostring) + " MiB/s` |",
        "",
        "| Phase | Wall | CPU | Max RSS |",
        "| --- | ---: | ---: | ---: |"
      ][],
      (.phases[] | "| `" + .name + "` | " + ms(.wall_ms) + " | " + ms(.cpu_ms) + " | " + bytes(.max_rss_bytes) + " |"),
      "",
      "Full machine-readable summary: [`summary.json`](./summary.json)."
    ' "${summary_json}"
  } > "${summary_md}"
  printf 'proof raw unseal/retrieval microbenchmark: %s\n' "${summary_md}"
  exit 0
fi

devnet_progress "bench-proof-micro: prewarming ${backend} PoRep params for ${sector_size} outside measured phases"
docker run --rm \
  "${docker_common_args[@]}" \
  "${image}" \
  porep-proof-microbench \
    --backend "${backend}" \
    --sector-size "${sector_size}" \
    --work-dir /bench-run/prewarm-work \
    --prewarm-only \
  > "${prewarm_summary_json}" 2> "${prewarm_stderr_log}" &
prewarm_pid="$!"
prewarm_progress_pid=""
devnet_start_prewarm_progress \
  prewarm_progress_pid \
  "bench-proof-micro: ${backend} ${sector_size} parameter prewarm" \
  "${prewarm_stderr_log}"
if wait "${prewarm_pid}"; then
  devnet_stop_prewarm_progress "${prewarm_progress_pid}"
  devnet_progress "bench-proof-micro: ${backend} ${sector_size} parameter prewarm complete; summary=${prewarm_summary_json}"
  :
else
  status=$?
  devnet_stop_prewarm_progress "${prewarm_progress_pid}"
  if [[ -s "${prewarm_stderr_log}" ]]; then
    tail -40 "${prewarm_stderr_log}" >&2
  fi
  devnet_die "proof microbench parameter prewarm failed with exit code ${status}; see ${prewarm_stderr_log}"
fi

if docker run --rm \
  "${docker_common_args[@]}" \
  "${image}" \
  porep-proof-microbench \
    --backend "${backend}" \
    --sector-size "${sector_size}" \
    --work-dir /bench-run/work \
  > "${summary_json}" 2> "${stderr_log}"; then
  :
else
  status=$?
  if [[ -s "${stderr_log}" ]]; then
    tail -40 "${stderr_log}" >&2
  fi
  if [[ -s "${prewarm_summary_json}" ]]; then
    jq -r '
      "parameter prewarm: cache_id=" + (.parameter_cache_identifier // "unknown")
      + " vk_matches_params=" + ((.verifying_key_matches_params // false) | tostring)
      + " vk_rewritten=" + ((.verifying_key_rewritten // false) | tostring)
    ' "${prewarm_summary_json}" >&2 || true
  fi
  if grep -Fq 'post seal aggregation verifies' "${stderr_log}"; then
    printf 'hint: seal_commit_phase2 generated a proof, but local verify_seal returned false; check param-prewarm.json for exact parameter-cache/VK consistency.\n' >&2
  fi
  devnet_die "proof microbench failed with exit code ${status}; see ${stderr_log}"
fi

jq -e '.verify_seal == true and .raw_unseal_bytes_match == true' "${summary_json}" >/dev/null ||
  devnet_die "proof microbench correctness failed; see ${summary_json}"

summary_md="${run_dir}/summary.md"
{
  printf '# Proof microbenchmark\n\n'
  jq -r \
    --arg filProofsUseMulticoreSdr "${stacked_multicore_sdr_requested}" \
    --arg stackedSdrReplicationMode "${stacked_sdr_replication_mode}" \
    --arg parentCacheHost "${parent_cache_host}" \
    --arg parentCacheWindowNodes "${parent_cache_window_nodes}" \
    --slurpfile prewarm "${prewarm_summary_json}" '
    def ms($value): ($value | tostring) + " ms";
    def bytes($raw):
      ($raw | tonumber? // null) as $bytes
      | if $bytes == null then ""
        elif $bytes < 1024 then (($bytes|round|tostring) + " B")
        elif $bytes < 1048576 then (((($bytes / 1024) * 10 | round) / 10 | tostring) + " KiB")
        elif $bytes < 1073741824 then (((($bytes / 1048576) * 10 | round) / 10 | tostring) + " MiB")
        else (((($bytes / 1073741824) * 10 | round) / 10 | tostring) + " GiB")
        end;
    [
      "| Field | Value |",
      "| --- | --- |",
      "| Backend | `" + .backend + "` |",
      "| Sector size | `" + (.sector_size_label | tostring) + "` / " + bytes(.sector_size_bytes) + " |",
      "| Registered seal proof | `" + .registered_seal_proof + "` (`" + (.registered_seal_proof_id | tostring) + "`) |",
      "| PoRep layers | `" + (.porep_layers | tostring) + "` |",
      "| Stacked SDR replication | `" + $stackedSdrReplicationMode + "` |",
      "| FIL_PROOFS_USE_MULTICORE_SDR | `" + $filProofsUseMulticoreSdr + "` |",
      "| Proof length | `" + (.proof_len | tostring) + "` bytes |",
      "| Verify seal | `" + (.verify_seal | tostring) + "` |",
      "| Raw unseal bytes match | `" + (.raw_unseal_bytes_match | tostring) + "` |",
      "| Proof parameter cache | `" + .proof_parameter_cache + "` |",
      "| Parent cache | `" + ($prewarm[0].parent_cache // $parentCacheHost) + "` |",
      "| Parent cache window nodes | `" + (($prewarm[0].parent_cache_window_nodes // $parentCacheWindowNodes) | tostring) + "` |",
      "| Parameter cache id | `" + ($prewarm[0].parameter_cache_identifier // "unknown") + "` |",
      "| Parameter cache params | `" + ($prewarm[0].parameter_cache_params_path // "unknown") + "` |",
      "| Parameter cache verifying key | `" + ($prewarm[0].parameter_cache_verifying_key_path // "unknown") + "` |",
      "| Parameter cache metadata | `" + ($prewarm[0].parameter_cache_metadata_path // "unknown") + "` |",
      "| Verifying key matches params | `" + (($prewarm[0].verifying_key_matches_params // false) | tostring) + "` |",
      "| Verifying key rewritten during prewarm | `" + (($prewarm[0].verifying_key_rewritten // false) | tostring) + "` |",
      "| Parameter prewarm | wall " + ms($prewarm[0].wall_ms) + ", CPU " + ms($prewarm[0].cpu_ms) + ", max RSS " + bytes($prewarm[0].max_rss_bytes) + " |",
      "",
      "| Phase | Wall | CPU | Max RSS |",
      "| --- | ---: | ---: | ---: |"
    ][],
    (.phases[] | "| `" + .name + "` | " + ms(.wall_ms) + " | " + ms(.cpu_ms) + " | " + bytes(.max_rss_bytes) + " |"),
    "",
    "Full machine-readable summary: [`summary.json`](./summary.json)."
  ' "${summary_json}"
} > "${summary_md}"

printf 'proof microbenchmark: %s\n' "${summary_md}"
