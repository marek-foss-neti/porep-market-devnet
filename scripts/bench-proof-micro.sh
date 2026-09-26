#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command jq
devnet_require_command node

backend="$(devnet_normalize_proof_backend "${1:-${DEVNET_PROOF_BACKEND:-stacked}}")"
sector_size="${2:-${DEVNET_SECTOR_SIZE:-8mib}}"
sector_size="$(devnet_normalize_sector_size "${sector_size}")"
mode="${3:-full}"
bench_profile="${BENCH_PROOF_MICRO_PROFILE:-}"
case "${bench_profile}" in
  ""|zigzag-512) ;;
  *) devnet_die "unknown proof microbench profile: ${bench_profile}" ;;
esac
if [[ "${bench_profile}" == "zigzag-512" ]]; then
  [[ "${backend}" == "zigzag" && "${sector_size}" == "512mib" && ( "${mode}" == "full" || "${mode}" == "prewarm-only" ) ]] ||
    devnet_die "zigzag-512 requires zigzag 512mib full or prewarm-only"
fi
profile_args=()
[[ -z "${bench_profile}" ]] || profile_args=(--profile "${bench_profile}")
case "${mode}" in
  full|prewarm-only|prepare-fixture|unseal-only) ;;
  *) devnet_die "invalid proof microbench mode: ${mode}; expected full, prewarm-only, prepare-fixture, or unseal-only" ;;
esac
if [[ "${mode}" == "prewarm-only" && "${backend}" != "zigzag" ]]; then
  devnet_die "prewarm-only mode is reserved for ZigZag setup"
fi

microbench_layers="${BENCH_PROOF_MICRO_LAYERS:-${POREP_PROOF_MICROBENCH_LAYERS:-}}"
if [[ -z "${microbench_layers}" && -z "${bench_profile}" && "${mode}" == "full" && "${sector_size}" == "512mib" ]]; then
  microbench_layers="11"
fi
if [[ -n "${bench_profile}" && -n "${microbench_layers}" ]]; then
  devnet_die "zigzag-512 has fixed layers; unset BENCH_PROOF_MICRO_LAYERS and POREP_PROOF_MICROBENCH_LAYERS"
fi
case "${microbench_layers}" in
  ""|2|11|15|19|22|25) ;;
  *) devnet_die "invalid proof microbench layer override: ${microbench_layers}; expected one of: 2, 11, 15, 19, 22, 25" ;;
esac

telemetry_interval_ms="${BENCH_TELEMETRY_INTERVAL_MS:-500}"
[[ "${telemetry_interval_ms}" =~ ^[0-9]+$ ]] ||
  devnet_die "BENCH_TELEMETRY_INTERVAL_MS must be an integer"
((telemetry_interval_ms >= 100 && telemetry_interval_ms <= 60000)) ||
  devnet_die "BENCH_TELEMETRY_INTERVAL_MS must be between 100 and 60000"

normalize_microbench_bool() {
  local value label
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  label="${2:-boolean value}"
  case "${value}" in
    1|true|yes|on) printf '1\n' ;;
    0|false|no|off|'') printf '0\n' ;;
    *) devnet_die "invalid boolean value for ${label}: ${1}; expected 1/0, true/false, yes/no, or on/off" ;;
  esac
}

stacked_multicore_sdr_requested="0"
if [[ "${backend}" == "stacked" ]]; then
  stacked_multicore_sdr_requested="$(normalize_microbench_bool "${BENCH_STACKED_USE_MULTICORE_SDR:-${FIL_PROOFS_USE_MULTICORE_SDR:-1}}" "Stacked multicore SDR")"
fi
retain_zigzag_work_artifacts="$(normalize_microbench_bool "${BENCH_RETAIN_ZIGZAG_WORK_ARTIFACTS:-0}" "BENCH_RETAIN_ZIGZAG_WORK_ARTIFACTS")"
retain_stacked_work_artifacts="$(normalize_microbench_bool "${BENCH_RETAIN_STACKED_WORK_ARTIFACTS:-0}" "BENCH_RETAIN_STACKED_WORK_ARTIFACTS")"
prune_buildkit_after_bench="$(normalize_microbench_bool "${BENCH_PRUNE_BUILDKIT_AFTER_BENCH:-1}" "BENCH_PRUNE_BUILDKIT_AFTER_BENCH")"
stacked_sdr_replication_mode="not-applicable"
if [[ "${backend}" == "stacked" ]]; then
  if [[ "${stacked_multicore_sdr_requested}" == "1" ]]; then
    stacked_sdr_replication_mode="multicore"
  else
    stacked_sdr_replication_mode="single-core"
  fi
fi

devnet_prepare_runtime

image_manifest="$(devnet_proof_microbench_manifest_for_backend "${backend}")"
image="$(devnet_proof_microbench_image_for_backend "${backend}")"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
safe_sector="$(printf '%s' "${sector_size}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
run_name="bench-proof-micro-${backend}-${safe_sector}"
[[ -z "${bench_profile}" ]] || run_name="${run_name}-${bench_profile}"
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
telemetry_ndjson="${run_dir}/telemetry.ndjson"
telemetry_summary_json="${run_dir}/telemetry-summary.json"
prewarm_telemetry_ndjson="${run_dir}/param-prewarm-telemetry.ndjson"
prewarm_telemetry_summary_json="${run_dir}/param-prewarm-telemetry-summary.json"
fixture_telemetry_ndjson="${run_dir}/fixture-telemetry.ndjson"
fixture_telemetry_summary_json="${run_dir}/fixture-telemetry-summary.json"
provenance_json="${run_dir}/provenance.json"
report_json="${run_dir}/report.json"
fixture_stderr_log="${run_dir}/fixture.stderr.log"
prewarm_stderr_log="${run_dir}/param-prewarm.stderr.log"
stderr_log="${run_dir}/stderr.log"
unseal_cidfile="${run_dir}/unseal.cid"
measured_cidfile="${run_dir}/container.cid"
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
  -e "POREP_PROOF_MICROBENCH_TELEMETRY_INTERVAL_MS=${telemetry_interval_ms}"
  -v "${parameter_cache_host}:/var/tmp/filecoin-proof-parameters:rw"
  -v "${run_dir}:/bench-run:rw"
  "${docker_parent_cache_args[@]}"
)
zigzag_setup_args=()
prewarm_limit_args=()
if [[ "${backend}" == "zigzag" ]]; then
  setup_batch_points="${BENCH_ZIGZAG_SETUP_BATCH_POINTS:-65536}"
  setup_workers="${BENCH_ZIGZAG_SETUP_WORKERS:-2}"
  setup_budget_bytes="${BENCH_ZIGZAG_SETUP_BUDGET_BYTES:-100000000000}"
  for setup_value in "${setup_batch_points}" "${setup_workers}" "${setup_budget_bytes}"; do
    [[ "${setup_value}" =~ ^[0-9]+$ ]] && (( setup_value > 0 )) ||
      devnet_die "ZigZag setup batch, workers, and budget must be positive integers"
  done
  mkdir -p "${run_dir}/prewarm-work"
  zigzag_setup_args=(
    -e "FIL_PROOFS_ZIGZAG_SETUP_BATCH_POINTS=${setup_batch_points}"
    -e "FIL_PROOFS_ZIGZAG_SETUP_WORKERS=${setup_workers}"
    -e "FIL_PROOFS_ZIGZAG_SETUP_BUDGET_BYTES=${setup_budget_bytes}"
    -e "FIL_PROOFS_ZIGZAG_SETUP_SCRATCH_DIR=/var/tmp/filecoin-proof-parameters/zigzag-setup-scratch"
    -e "FIL_PROOFS_ZIGZAG_SETUP_PHASE_FILE=/bench-run/zigzag-setup-phase.txt"
  )
  if [[ "${mode}" == "prewarm-only" ]]; then
    setup_memory_bytes="${BENCH_ZIGZAG_SETUP_MEMORY_BYTES:-110000000000}"
    [[ "${setup_memory_bytes}" =~ ^[0-9]+$ ]] && (( setup_memory_bytes > 0 )) ||
      devnet_die "BENCH_ZIGZAG_SETUP_MEMORY_BYTES must be a positive integer"
    prewarm_limit_args=(--memory "${setup_memory_bytes}" --memory-swap "${setup_memory_bytes}")
    if [[ "${BENCH_ZIGZAG_SETUP_REQUIRE_MISS:-0}" == "1" ]]; then
      [[ -z "$(find "${parameter_cache_host}" -maxdepth 1 -type f -name 'v28-zigzag-proof-of-replication-*.params' -print -quit)" ]] ||
        devnet_die "ZigZag setup acceptance requires a cache miss; select an empty parameter directory"
    fi
  fi
fi

bench_epoch_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

bench_prewarm_exit() {
  local script_status="$?"
  trap - EXIT
  set +e
  devnet_stop_prewarm_progress "${prewarm_progress_pid:-}"
  local container_id="" captured=0 report_saved=1
  local container_json="${run_dir}/prewarm-container.json"
  if [[ -f "${measured_cidfile}" && ! -L "${measured_cidfile}" ]]; then
    container_id="$(cat "${measured_cidfile}")"
  fi
  if [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] &&
    docker inspect --format '{"id":{{json .Id}},"state":{{json .State}},"memory_limit_bytes":{{json .HostConfig.Memory}},"memory_swap_limit_bytes":{{json .HostConfig.MemorySwap}}}' \
      "${container_id}" > "${container_json}.temporary" 2>> "${prewarm_stderr_log}"; then
    mv -- "${container_json}.temporary" "${container_json}"
    captured=1
  else
    jq -n --arg id "${container_id}" \
      '{id:$id,state:null,capture_error:"container state unavailable; container retained if it exists"}' > "${container_json}"
  fi
  if ((script_status != 0)); then
    prewarm_finished_ms="${prewarm_finished_ms:-$(bench_epoch_ms)}"
    if node "${DEVNET_ROOT}/scripts/write-proof-micro-failure.mjs" \
      "${report_json}" "${DEVNET_ROOT}" "${image_manifest}" "${image}" "${backend}" "${sector_size}" \
      "${prewarm_started_ms}" "${prewarm_finished_ms}" "${prewarm_exit_code:-${script_status}}" \
      "${container_json}" "${prewarm_telemetry_ndjson}" "${prewarm_summary_json}" \
      "${prewarm_stderr_log}" "${run_dir}/zigzag-setup-phase.txt"; then
      printf 'proof parameter prewarm failure: %s\n' "${report_json}" >&2
    else
      report_saved=0
      printf 'could not write prewarm failure report; retained diagnostics and container: %s\n' "${run_dir}" >&2
    fi
  fi
  # Final state and failure report are durable before removal. Never remove
  # a running container or one whose state could not be inspected.
  if ((captured && report_saved)) && jq -e '.state.Running == false' "${container_json}" >/dev/null; then
    docker rm "${container_id}" > "${run_dir}/prewarm-container-removal.log" 2>&1 ||
      printf 'could not remove stopped prewarm container: %s\n' "${container_id}" >&2
  fi
  exit "${script_status}"
}

bench_finalize_telemetry() {
  local raw="$1"
  local output="$2"
  [[ -f "${raw}" && ! -L "${raw}" && -s "${raw}" ]] ||
    devnet_die "microbenchmark telemetry is missing or empty: ${raw}"
  node "${DEVNET_ROOT}/scripts/summarize-proof-micro-telemetry.mjs" "${raw}" "${output}"
  jq -e '
    .schema_version == 1
    and (.sample_count | type == "number" and . > 0)
    and (.overall.cgroup.kernel_memory_peak_bytes | type == "number")
    and (.overall.disk.sampled_total_allocated_peak_bytes | type == "number")
  ' "${output}" >/dev/null || devnet_die "microbenchmark telemetry summary is invalid: ${output}"
}

bench_write_provenance() {
  local measured_mode="$1"
  local started_ms="$2"
  local finished_ms="$3"
  local telemetry_summary="$4"
  local benchmark_summary="$5"
  node "${DEVNET_ROOT}/scripts/write-proof-micro-provenance.mjs" \
    "${provenance_json}" \
    "${DEVNET_ROOT}" \
    "${image_manifest}" \
    "${image}" \
    "${measured_mode}" \
    "${backend}" \
    "${sector_size}" \
    "${microbench_layers}" \
    "${started_ms}" \
    "${finished_ms}" \
    "${telemetry_summary}" \
    "${benchmark_summary}"
  jq -e '
    .schema_version == 1
    and (.invocation.outer_wall_ms | type == "number" and . >= 0)
    and (.build.image.id | type == "string" and startswith("sha256:"))
    and (.instrumentation.telemetry_summary_sha256 | type == "string" and length == 64)
  ' "${provenance_json}" >/dev/null || devnet_die "microbenchmark provenance is invalid: ${provenance_json}"
}

bench_compose_report() {
  local measured_mode="$1"
  local benchmark_summary="$2"
  local telemetry_summary="$3"
  local prewarm_summary="$4"
  local prewarm_telemetry_summary="$5"
  node "${DEVNET_ROOT}/scripts/compose-proof-micro-report.mjs" \
    "${report_json}" \
    "${measured_mode}" \
    "${benchmark_summary}" \
    "${telemetry_summary}" \
    "${provenance_json}" \
    "${prewarm_summary}" \
    "${prewarm_telemetry_summary}"
  jq -e '
    .schema_version == 1
    and (.telemetry.schema_version == 1)
    and (.provenance.schema_version == 1)
    and (if .mode == "full" then
      (.benchmark.porep_partitions | type == "number" and . >= 1)
      and (.benchmark.challenges_per_layer_per_partition | type == "number" and . >= 1)
    else true end)
    and (.derived.cgroup_memory_peak_bytes | type == "number")
    and (.telemetry.overall.cgroup.cpuset_cpus_effective | type == "string" and length > 0)
    and (.telemetry.overall.cgroup.cpu_period_usec | type == "number" and . > 0)
  ' "${report_json}" >/dev/null || devnet_die "microbenchmark report is invalid: ${report_json}"
}

bench_cleanup_successful_run() {
  local cleanup_json buildkit_prune_log removed_allocated_bytes retain_work_artifacts status
  cleanup_json="${run_dir}/cleanup.json"
  buildkit_prune_log="${run_dir}/buildkit-prune.log"
  retain_work_artifacts="${retain_zigzag_work_artifacts}"
  if [[ "${backend}" == "stacked" ]]; then
    retain_work_artifacts="${retain_stacked_work_artifacts}"
  fi

  if [[ "${prune_buildkit_after_bench}" == "1" || ( "${mode}" == "full" && "${retain_work_artifacts}" == "0" ) ]]; then
    printf '\n## Post-run cleanup\n\n' >> "${summary_md}"
  fi

  if [[ "${mode}" == "full" ]]; then
    if [[ "${retain_work_artifacts}" == "1" ]]; then
      devnet_progress "bench-proof-micro: retaining ${parent_cache_kind} work artifacts by request"
    else
      devnet_progress "bench-proof-micro: pruning successful ${parent_cache_kind} run artifacts"
      node "${DEVNET_ROOT}/scripts/cleanup-proof-micro-artifacts.mjs" "${run_dir}" "${backend}" >/dev/null
      removed_allocated_bytes="$(jq -r '.removed_allocated_bytes // .removed_logical_bytes' "${cleanup_json}")"
      devnet_progress "bench-proof-micro: pruned $(devnet_format_bytes "${removed_allocated_bytes}") from the run directory; manifest=${cleanup_json}"
      if [[ "${backend}" == "zigzag" ]]; then
        {
          printf -- '- ZigZag sealed replica and `*.dat` tree artifacts: removed after successful report validation.\n'
          printf -- '- Retained commitment record: `work/zigzag-cache/zigzag-aux.json`.\n'
        } >> "${summary_md}"
      else
        {
          printf -- '- Stacked staged/sealed replicas, seal-cache `*.dat` files, and isolated proof parameters: removed after successful report validation.\n'
          printf -- '- Retained auxiliary records: `work/seal-cache/p_aux` and `work/seal-cache/t_aux`.\n'
        } >> "${summary_md}"
      fi
      printf -- '- Cleanup manifest: [`cleanup.json`](./cleanup.json); reclaimed allocation: %s.\n' "$(devnet_format_bytes "${removed_allocated_bytes}")" >> "${summary_md}"
    fi
  fi

  if [[ "${prune_buildkit_after_bench}" == "1" ]]; then
    devnet_progress "bench-proof-micro: pruning unused BuildKit cache"
    if docker buildx prune --force > "${buildkit_prune_log}" 2>&1; then
      devnet_progress "bench-proof-micro: BuildKit cache prune complete; log=${buildkit_prune_log}"
    else
      status=$?
      tail -40 "${buildkit_prune_log}" >&2 || true
      devnet_die "proof microbench succeeded, but BuildKit cache cleanup failed with exit code ${status}; see ${buildkit_prune_log}"
    fi
    printf -- '- Unused BuildKit cache: pruned; log: [`buildkit-prune.log`](./buildkit-prune.log).\n' >> "${summary_md}"
  fi
}

bench_append_telemetry_markdown() {
  local report="$1"
  local markdown="$2"
  jq -r '
    def bytes($raw):
      ($raw | tonumber? // null) as $bytes
      | if $bytes == null then "unavailable"
        elif $bytes < 1024 then (($bytes|round|tostring) + " B")
        elif $bytes < 1048576 then (((($bytes / 1024) * 10 | round) / 10 | tostring) + " KiB")
        elif $bytes < 1073741824 then (((($bytes / 1048576) * 100 | round) / 100 | tostring) + " MiB")
        else (((($bytes / 1073741824) * 1000 | round) / 1000 | tostring) + " GiB")
        end;
    def limit($bytes; $unlimited): if $unlimited then "unlimited" else bytes($bytes) end;
    [
      "",
      "## Container and disk telemetry",
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      "| Outer measured-container wall | " + (.derived.outer_wall_ms | tostring) + " ms |",
      "| Unattributed outer wall | " + (.derived.unattributed_outer_wall_ms | tostring) + " ms |",
      "| Cgroup kernel memory peak | " + bytes(.derived.cgroup_memory_peak_bytes) + " |",
      "| Sampled cgroup memory.current peak | " + bytes(.telemetry.overall.cgroup.sampled_memory_current_peak_bytes) + " |",
      "| Sampled process RSS peak | " + bytes(.derived.sampled_process_rss_peak_bytes) + " |",
      "| Sampled process anonymous RSS peak | " + bytes(.derived.sampled_process_anon_peak_bytes) + " |",
      "| Sampled process file-backed RSS peak | " + bytes(.derived.sampled_process_file_peak_bytes) + " |",
      "| Cgroup memory.max | " + limit(.telemetry.overall.cgroup.memory_max_bytes; .telemetry.overall.cgroup.memory_max_unlimited) + " |",
      "| Sampled swap peak | " + bytes(.derived.swap_peak_bytes) + " |",
      "| Cgroup swap.max | " + limit(.telemetry.overall.cgroup.swap_max_bytes; .telemetry.overall.cgroup.swap_max_unlimited) + " |",
      "| Sampled allocated disk peak, all listed paths | " + bytes(.derived.sampled_disk_allocated_peak_bytes) + " |",
      "| Effective CPU set | `" + (.telemetry.overall.cgroup.cpuset_cpus_effective // "unavailable") + "` |",
      "| Cgroup CPU quota / period | "
        + (if .telemetry.overall.cgroup.cpu_quota_unlimited then "unlimited"
           else ((.telemetry.overall.cgroup.cpu_quota_usec // "unavailable") | tostring) end)
        + " / " + ((.telemetry.overall.cgroup.cpu_period_usec // "unavailable") | tostring) + " us |",
      "| Cgroup CPU quota cores | " + ((.derived.cpu_quota_cores // "unlimited") | tostring) + " |",
      "| Cgroup CPU throttled | " + ((.derived.cpu_throttled_usec // "unavailable") | tostring) + " us |",
      "| OOM / OOM-kill delta | " + ((.derived.oom_delta // 0) | tostring) + " / " + ((.derived.oom_kill_delta // 0) | tostring) + " |",
      "| Sampling | " + (.telemetry.sample_count | tostring) + " samples at " + (.telemetry.sampling_interval_ms | tostring) + " ms; maximum observed gap " + (.telemetry.maximum_observed_sample_gap_ms | tostring) + " ms |",
      "",
      "Per-phase cgroup and disk values below are sampled maxima. The cgroup kernel memory peak above is the exact container-wide `memory.peak` value.",
      "",
      "| Phase | Samples | Process RSS peak | Cgroup current peak | Allocated disk peak |",
      "| --- | ---: | ---: | ---: | ---: |"
    ][],
    (.telemetry.phases[] |
      "| `" + .phase + "` | " + (.sample_count | tostring)
      + " | " + bytes(.process_peak.rss_bytes)
      + " | " + bytes(.cgroup.sampled_memory_current_peak_bytes)
      + " | " + bytes(.disk.sampled_total_allocated_peak_bytes) + " |"),
    "",
    "| Disk path | Apparent peak | Allocated peak |",
    "| --- | ---: | ---: |",
    (.telemetry.overall.disk.path_peaks[] |
      "| `" + .label + "` (`" + .path + "`) | " + bytes(.peak_apparent_bytes)
      + " | " + bytes(.peak_allocated_bytes) + " |"),
    "",
    "Machine-readable combined report: [`report.json`](./report.json).",
    "Raw telemetry: [`telemetry.ndjson`](./telemetry.ndjson); aggregate: [`telemetry-summary.json`](./telemetry-summary.json).",
    "Run provenance: [`provenance.json`](./provenance.json)."
  ' "${report}" >> "${markdown}"
}

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
  local telemetry_container_path="$3"
  local cidfile="$4"
  local fixture_pid fixture_progress_pid status
  rm -f -- "${cidfile}"
  devnet_progress "bench-proof-micro: preparing ${backend} ${sector_size} unseal fixture at ${fixture_host}"
  measured_started_ms="$(bench_epoch_ms)"
  docker run --rm \
    --cidfile "${cidfile}" \
    "${docker_common_args[@]}" \
    -e "POREP_PROOF_MICROBENCH_TELEMETRY_PATH=${telemetry_container_path}" \
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
    measured_finished_ms="$(bench_epoch_ms)"
    devnet_stop_prewarm_progress "${fixture_progress_pid}"
    devnet_progress "bench-proof-micro: ${backend} ${sector_size} unseal fixture preparation complete; summary=${output_json}"
    return 0
  else
    status=$?
    measured_finished_ms="$(bench_epoch_ms)"
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
  measured_started_ms="$(bench_epoch_ms)"
  docker run --rm \
    --cidfile "${unseal_cidfile}" \
    "${docker_common_args[@]}" \
    -e "POREP_PROOF_MICROBENCH_TELEMETRY_PATH=/bench-run/telemetry.ndjson" \
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
    measured_finished_ms="$(bench_epoch_ms)"
    devnet_stop_prewarm_progress "${unseal_progress_pid}"
    devnet_progress "bench-proof-micro: ${backend} ${sector_size} measured unseal-only complete; summary=${summary_json}"
    return 0
  else
    status=$?
    measured_finished_ms="$(bench_epoch_ms)"
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
  if run_prepare_fixture \
    "${fixture_summary_json}" \
    "${fixture_stderr_log}" \
    "/bench-run/telemetry.ndjson" \
    "${measured_cidfile}"; then
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
  bench_finalize_telemetry "${telemetry_ndjson}" "${telemetry_summary_json}"
  bench_write_provenance \
    "prepare-fixture" \
    "${measured_started_ms}" \
    "${measured_finished_ms}" \
    "${telemetry_summary_json}" \
    "${fixture_summary_json}"
  bench_compose_report \
    "prepare-fixture" \
    "${fixture_summary_json}" \
    "${telemetry_summary_json}" \
    "-" \
    "-"
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
  bench_append_telemetry_markdown "${report_json}" "${summary_md}"
  bench_cleanup_successful_run
  printf 'proof microbenchmark fixture: %s\n' "${summary_md}"
  exit 0
fi

if [[ "${mode}" == "unseal-only" ]]; then
  if [[ ! -f "${fixture_host}/fixture.json" ]]; then
    devnet_progress "bench-proof-micro: fixture is missing; preparing it outside the measured unseal phase"
    if run_prepare_fixture \
      "${fixture_summary_json}" \
      "${fixture_stderr_log}" \
      "/bench-run/fixture-telemetry.ndjson" \
      "${measured_cidfile}"; then
      bench_finalize_telemetry "${fixture_telemetry_ndjson}" "${fixture_telemetry_summary_json}"
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
  bench_finalize_telemetry "${telemetry_ndjson}" "${telemetry_summary_json}"
  bench_write_provenance \
    "unseal-only" \
    "${measured_started_ms}" \
    "${measured_finished_ms}" \
    "${telemetry_summary_json}" \
    "${summary_json}"
  bench_compose_report \
    "unseal-only" \
    "${summary_json}" \
    "${telemetry_summary_json}" \
    "-" \
    "-"

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
  bench_append_telemetry_markdown "${report_json}" "${summary_md}"
  bench_cleanup_successful_run
  printf 'proof raw unseal/retrieval microbenchmark: %s\n' "${summary_md}"
  exit 0
fi

devnet_progress "bench-proof-micro: prewarming ${backend} PoRep params for ${sector_size} outside measured phases"
rm -f -- "${measured_cidfile}"
prewarm_started_ms="$(bench_epoch_ms)"
prewarm_remove_args=(--rm)
if [[ "${mode}" == "prewarm-only" ]]; then
  prewarm_remove_args=()
  trap bench_prewarm_exit EXIT
fi
docker run "${prewarm_remove_args[@]}" \
  --cidfile "${measured_cidfile}" \
  "${docker_common_args[@]}" \
  "${zigzag_setup_args[@]}" \
  "${prewarm_limit_args[@]}" \
  -e "POREP_PROOF_MICROBENCH_TELEMETRY_PATH=/bench-run/param-prewarm-telemetry.ndjson" \
  "${image}" \
  porep-proof-microbench \
    --backend "${backend}" \
    --sector-size "${sector_size}" \
    --work-dir /bench-run/prewarm-work \
    --prewarm-only \
    "${profile_args[@]}" \
  > "${prewarm_summary_json}" 2> "${prewarm_stderr_log}" &
prewarm_pid="$!"
prewarm_progress_pid=""
devnet_start_prewarm_progress \
  prewarm_progress_pid \
  "bench-proof-micro: ${backend} ${sector_size} parameter prewarm" \
  "${prewarm_stderr_log}"
if wait "${prewarm_pid}"; then
  prewarm_finished_ms="$(bench_epoch_ms)"
  devnet_stop_prewarm_progress "${prewarm_progress_pid}"
  prewarm_progress_pid=""
  devnet_progress "bench-proof-micro: ${backend} ${sector_size} parameter prewarm complete; summary=${prewarm_summary_json}"
  :
else
  status=$?
  prewarm_exit_code="${status}"
  prewarm_finished_ms="$(bench_epoch_ms)"
  devnet_stop_prewarm_progress "${prewarm_progress_pid}"
  prewarm_progress_pid=""
  if [[ -s "${prewarm_stderr_log}" ]]; then
    tail -40 "${prewarm_stderr_log}" >&2
  fi
  devnet_die "proof microbench parameter prewarm failed with exit code ${status}; see ${prewarm_stderr_log}"
fi
bench_finalize_telemetry "${prewarm_telemetry_ndjson}" "${prewarm_telemetry_summary_json}"
if [[ "${bench_profile}" == "zigzag-512" ]]; then
  jq -e '
    .profile.name == "zigzag-512"
    and .profile.padded_sector_bytes == 536870912
    and .profile.nodes == 16777216
    and .profile.binary_tree_depth == 24
    and .profile.layers == 11
    and .profile.partitions == 10
    and .profile.minimum_challenges == 176
    and .profile.challenges_per_layer_per_partition == 18
    and .profile.total_challenge_instances == 1980
    and .verifying_key_matches_params == true
  ' "${prewarm_summary_json}" >/dev/null || devnet_die "zigzag-512 prewarm used wrong parameters"
fi

if [[ "${mode}" == "prewarm-only" ]]; then
  bench_write_provenance \
    "prewarm-only" "${prewarm_started_ms}" "${prewarm_finished_ms}" \
    "${prewarm_telemetry_summary_json}" "${prewarm_summary_json}"
  bench_compose_report \
    "prewarm-only" "${prewarm_summary_json}" "${prewarm_telemetry_summary_json}" - -
  jq -e --argjson limit "${setup_memory_bytes}" \
    --argjson page_size "$(getconf PAGESIZE)" \
    '.benchmark.verifying_key_matches_params == true
      and .derived.cgroup_memory_peak_bytes <= $limit
      and .derived.swap_peak_bytes == 0
      and .derived.oom_delta == 0
      and .derived.oom_kill_delta == 0
      and .telemetry.overall.cgroup.memory_max_bytes <= $limit
      and .telemetry.overall.cgroup.memory_max_bytes > ($limit - $page_size)
      and .telemetry.overall.cgroup.swap_max_bytes == 0' \
    "${report_json}" >/dev/null || devnet_die "ZigZag prewarm exceeded its memory, swap, or correctness limit; see ${report_json}"
  if [[ "${BENCH_ZIGZAG_SETUP_REQUIRE_MISS:-0}" == "1" ]]; then
    jq -e '.parameter_cache_hit == false' "${prewarm_summary_json}" >/dev/null ||
      devnet_die "ZigZag setup acceptance unexpectedly hit existing parameter cache"
  fi
  params_name="$(basename "$(jq -r '.parameter_cache_params_path' "${prewarm_summary_json}")")"
  vk_name="$(basename "$(jq -r '.parameter_cache_verifying_key_path' "${prewarm_summary_json}")")"
  meta_name="$(basename "$(jq -r '.parameter_cache_metadata_path' "${prewarm_summary_json}")")"
  sha256sum "${parameter_cache_host}/${params_name}" \
    "${parameter_cache_host}/${vk_name}" \
    "${parameter_cache_host}/${meta_name}" > "${run_dir}/parameter-cache-sha256.txt"
  summary_md="${run_dir}/summary.md"
  {
    printf '# ZigZag parameter prewarm\n\n'
    printf 'Report: [report.json](./report.json)\n\n'
    printf 'Parameter digests: [parameter-cache-sha256.txt](./parameter-cache-sha256.txt)\n\n'
    jq -r '"Cache hit: \(.benchmark.parameter_cache_hit)\nKernel memory.peak: \(.derived.cgroup_memory_peak_bytes) bytes\nContainer memory.max: \(.telemetry.overall.cgroup.memory_max_bytes) bytes\nSampled swap peak: \(.derived.swap_peak_bytes) bytes\nOOM kills: \(.derived.oom_kill_delta)\nWall time: \(.benchmark.wall_ms) ms\n"' "${report_json}"
  } > "${summary_md}"
  printf 'proof parameter prewarm: %s\n' "${summary_md}"
  exit 0
fi

rm -f -- "${measured_cidfile}"
measured_started_ms="$(bench_epoch_ms)"
if docker run --rm \
  --cidfile "${measured_cidfile}" \
  "${docker_common_args[@]}" \
  -e "POREP_PROOF_MICROBENCH_TELEMETRY_PATH=/bench-run/telemetry.ndjson" \
  "${image}" \
  porep-proof-microbench \
    --backend "${backend}" \
    --sector-size "${sector_size}" \
    --work-dir /bench-run/work \
    "${profile_args[@]}" \
  > "${summary_json}" 2> "${stderr_log}"; then
  measured_finished_ms="$(bench_epoch_ms)"
  :
else
  status=$?
  measured_finished_ms="$(bench_epoch_ms)"
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
if [[ "${bench_profile}" == "zigzag-512" ]]; then
  jq -e --slurpfile prewarm "${prewarm_summary_json}" '
    .profile == $prewarm[0].profile
    and .porep_layers == 11
    and .porep_partitions == 10
    and .minimum_total_challenges == 176
    and .challenges_per_layer_per_partition == 18
    and .proof_len == 1920
    and .unsealed_bytes == 532676608
  ' "${summary_json}" >/dev/null || devnet_die "zigzag-512 seal/prove/verify/unseal parameters differ from prewarm"
fi
bench_finalize_telemetry "${telemetry_ndjson}" "${telemetry_summary_json}"
bench_write_provenance \
  "full" \
  "${measured_started_ms}" \
  "${measured_finished_ms}" \
  "${telemetry_summary_json}" \
  "${summary_json}"
bench_compose_report \
  "full" \
  "${summary_json}" \
  "${telemetry_summary_json}" \
  "${prewarm_summary_json}" \
  "${prewarm_telemetry_summary_json}"

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
      "| Bench profile | `" + (.profile.name // "default") + "` |",
      "| Sector size | `" + (.sector_size_label | tostring) + "` / " + bytes(.sector_size_bytes) + " |",
      "| Registered seal proof | `" + .registered_seal_proof + "` (`" + (.registered_seal_proof_id | tostring) + "`) |",
      "| PoRep layers | `" + (.porep_layers | tostring) + "` |",
      "| PoRep partitions | `" + (.porep_partitions | tostring) + "` |",
      "| Minimum total challenges | `" + (.minimum_total_challenges | tostring) + "` |",
      "| Challenges per layer per partition | `" + (.challenges_per_layer_per_partition | tostring) + "` |",
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

bench_append_telemetry_markdown "${report_json}" "${summary_md}"
bench_cleanup_successful_run

printf 'proof microbenchmark: %s\n' "${summary_md}"
