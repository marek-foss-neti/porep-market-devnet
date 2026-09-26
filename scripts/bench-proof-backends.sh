#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command jq
devnet_require_command just
devnet_require_command docker

backend_order="${BENCH_BACKEND_ORDER:-zigzag,stacked}"
repetitions="${BENCH_REPETITIONS:-1}"
bench_sector_size="$(devnet_requested_sector_size "${1:-${BENCH_SECTOR_SIZE:-${DEVNET_SECTOR_SIZE:-8mib}}}")"
bench_sector_size_bytes="$(devnet_sector_size_bytes "${bench_sector_size}")"
if [[ -n "${BENCH_PARENT_CACHE_WINDOW_NODES:-}" ]]; then
  DEVNET_PARENT_CACHE_WINDOW_NODES="${BENCH_PARENT_CACHE_WINDOW_NODES}"
fi
parent_cache_window_nodes="$(devnet_parent_cache_window_nodes)"
[[ "${repetitions}" =~ ^[0-9]+$ && "${repetitions}" -ge 1 ]] ||
  devnet_die "BENCH_REPETITIONS must be a positive integer"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
comparison_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-bench-proof-backends"
devnet_require_safe_write_path "${DEVNET_ROOT}/.runtime/runs" directory
devnet_require_safe_write_path "${comparison_dir}" directory
mkdir -p "${comparison_dir}"
records="${comparison_dir}/runs.ndjson"
: > "${records}"

latest_run_dir() {
  local scenario="$1"
  find "${DEVNET_ROOT}/.runtime/runs" -maxdepth 1 -type d -name "*-${scenario}" -print0 |
    xargs -0 ls -td 2>/dev/null |
    head -n1
}

proof_parameter_file_count() {
  local cache_dir="${1:-${DEVNET_PROOF_PARAMETERS_DIR}}"
  if [[ ! -d "${cache_dir}" ]]; then
    printf '0\n'
    return 0
  fi
  find "${cache_dir}" \
    -path "${cache_dir}/zigzag-proof-sidecars" -prune -o \
    -type f -print | wc -l | tr -d '[:space:]'
}

proof_parameter_cache_bytes() {
  local cache_dir="${1:-${DEVNET_PROOF_PARAMETERS_DIR}}"
  if [[ ! -d "${cache_dir}" ]]; then
    printf '0\n'
    return 0
  fi
  find "${cache_dir}" \
    -path "${cache_dir}/zigzag-proof-sidecars" -prune -o \
    -type f -exec sh -c '
      for path do
        stat -f "%z" "$path" 2>/dev/null || stat -c "%s" "$path"
      done
    ' sh {} + |
    awk '{sum += $1} END {printf "%d\n", sum + 0}'
}

prewarm_backend_params() {
  local backend="$1"
  local image prewarm_summary prewarm_stderr prewarm_pid prewarm_progress_pid status parameter_cache_host parent_cache_host
  local parameter_cache_file_count parameter_cache_bytes cleanup_json
  image="$(devnet_proof_microbench_image_for_backend "${backend}")"
  prewarm_summary="${comparison_dir}/param-prewarm-${backend}-${bench_sector_size}.json"
  prewarm_stderr="${comparison_dir}/param-prewarm-${backend}-${bench_sector_size}.stderr.log"
  parameter_cache_host="${DEVNET_PROOF_PARAMETERS_DIR}"
  if [[ "${backend}" == "stacked" ]]; then
    parameter_cache_host="${comparison_dir}/param-prewarm-${backend}-${bench_sector_size}-cache"
    devnet_require_safe_write_path "${parameter_cache_host}" directory
    mkdir -p "${parameter_cache_host}"
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size}: using isolated transient proof parameter cache at ${parameter_cache_host}"
  else
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size}: using devnet proof parameter cache at ${parameter_cache_host}"
  fi
  parent_cache_host="$(devnet_parent_cache_dir_for_backend "${backend}")"
  devnet_require_safe_write_path "${parent_cache_host}" directory
  mkdir -p "${parent_cache_host}"
  devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size}: using persistent parent cache at ${parent_cache_host} window_nodes=${parent_cache_window_nodes}"
  devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size}: prewarming exact PoRep params outside measured benchmark windows"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e "FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters" \
    -e "FIL_PROOFS_USE_ZIGZAG=$(devnet_fil_proofs_use_zigzag "${backend}")" \
    -e "FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents" \
    -e "FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=$(devnet_fil_proofs_use_zigzag "${backend}")" \
    -e "FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE=${parent_cache_window_nodes}" \
    -e "FIL_PROOFS_SDR_PARENTS_CACHE_SIZE=${parent_cache_window_nodes}" \
    -e "FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/tmp/filecoin-zigzag-proof-sidecars" \
    -e "POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1" \
    -v "${parameter_cache_host}:/var/tmp/filecoin-proof-parameters:rw" \
    -v "${parent_cache_host}:/var/tmp/filecoin-parents:rw" \
    -v "${comparison_dir}:/bench-run:rw" \
    "${image}" \
    porep-proof-microbench \
      --backend "${backend}" \
      --sector-size "${bench_sector_size}" \
      --work-dir "/bench-run/param-prewarm-${backend}-${bench_sector_size}-work" \
      --prewarm-only \
    > "${prewarm_summary}" 2> "${prewarm_stderr}" &
  prewarm_pid="$!"
  prewarm_progress_pid=""
  devnet_start_prewarm_progress \
    prewarm_progress_pid \
    "bench-proof-backends: ${backend} ${bench_sector_size} parameter prewarm" \
    "${prewarm_stderr}"
  if wait "${prewarm_pid}"; then
    devnet_stop_prewarm_progress "${prewarm_progress_pid}"
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size}: parameter prewarm complete; summary=${prewarm_summary}"
    :
  else
    status=$?
    devnet_stop_prewarm_progress "${prewarm_progress_pid}"
    if [[ -s "${prewarm_stderr}" ]]; then
      tail -40 "${prewarm_stderr}" >&2
    fi
    devnet_die "proof backend parameter prewarm failed for ${backend} ${bench_sector_size} with exit code ${status}; see ${prewarm_stderr}"
  fi

  jq -e '.schema_version == 1 and (.wall_ms | type == "number")' "${prewarm_summary}" >/dev/null ||
    devnet_die "proof backend parameter prewarm summary is invalid: ${prewarm_summary}"
  parameter_cache_file_count="$(proof_parameter_file_count "${parameter_cache_host}")"
  parameter_cache_bytes="$(proof_parameter_cache_bytes "${parameter_cache_host}")"
  jq -nc \
    --arg backend "${backend}" \
    --arg kind "param-prewarm" \
    --arg action "completed" \
    --arg runDir "" \
    --arg summaryPath "${prewarm_summary}" \
    --arg reason "exact PoRep params prewarmed via porep-proof-microbench --prewarm-only; summary=${prewarm_summary}" \
    --argjson proofParameterCacheFileCount "${parameter_cache_file_count}" \
    --argjson proofParameterCacheBytes "${parameter_cache_bytes}" \
    --slurpfile prewarm "${prewarm_summary}" \
    '{
      backend:$backend,
      repetition:0,
      kind:$kind,
      action:$action,
      runDir:$runDir,
      summaryPath:$summaryPath,
      durationMs:$prewarm[0].wall_ms,
      proofBackend:$backend,
      devnetSectorSize:$prewarm[0].sector_size_label,
      devnetSectorSizeBytes:$prewarm[0].sector_size_bytes,
      proofParameterCacheStatus:"present",
      proofParameterCacheFileCount:$proofParameterCacheFileCount,
      proofParameterCacheBytes:$proofParameterCacheBytes,
      parentCache:($prewarm[0].parent_cache // ""),
      parentCacheWindowNodes:($prewarm[0].parent_cache_window_nodes // ""),
      reason:$reason
    }' >> "${records}"

  if [[ "${backend}" == "stacked" ]]; then
    cleanup_json="${comparison_dir}/param-prewarm-${backend}-${bench_sector_size}-cleanup.json"
    [[ "${parameter_cache_host}" == "${comparison_dir}/"* && -d "${parameter_cache_host}" && ! -L "${parameter_cache_host}" ]] ||
      devnet_die "refusing to remove unexpected Stacked prewarm cache path: ${parameter_cache_host}"
    rm -rf -- "${parameter_cache_host}"
    jq -n \
      --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg removedPath "${parameter_cache_host}" \
      --argjson removedFileCount "${parameter_cache_file_count}" \
      --argjson removedLogicalBytes "${parameter_cache_bytes}" \
      '{
        schemaVersion:1,
        cleanupKind:"post-success-stacked-prewarm-parameter-cache-prune",
        status:"completed",
        completedAt:$completedAt,
        removedPath:$removedPath,
        removedFileCount:$removedFileCount,
        removedLogicalBytes:$removedLogicalBytes
      }' > "${cleanup_json}"
    devnet_progress "bench-proof-backends: removed transient Stacked prewarm parameter cache; manifest=${cleanup_json}"
  fi
}

zigzag_prewarm_marker() {
  printf '%s\n' "${DEVNET_PROOF_PARAMETERS_DIR}/.zigzag-devnet-prewarm-${bench_sector_size}.json"
}

zigzag_static_param_pattern() {
  printf '%s\n' 'v*-zigzag-proof-of-replication-merkletree-poseidon_hasher-2-0-0-sha256_hasher-*.params'
}

zigzag_static_vk_pattern() {
  printf '%s\n' 'v*-zigzag-proof-of-replication-merkletree-poseidon_hasher-2-0-0-sha256_hasher-*.vk'
}

zigzag_static_files_json() {
  local pattern="$1"
  if [[ ! -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]]; then
    printf '[]\n'
    return 0
  fi
  find "${DEVNET_PROOF_PARAMETERS_DIR}" -maxdepth 1 -type f -name "${pattern}" -exec basename {} \; |
    LC_ALL=C sort |
    jq -R -s 'split("\n") | map(select(length > 0))'
}

zigzag_has_static_files() {
  local pattern="$1"
  [[ -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]] || return 1
  [[ -n "$(find "${DEVNET_PROOF_PARAMETERS_DIR}" -maxdepth 1 -type f -name "${pattern}" -print -quit)" ]]
}

zigzag_static_params_ready() {
  [[ -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]] || return 1
  local marker param_pattern vk_pattern
  param_pattern="$(zigzag_static_param_pattern)"
  vk_pattern="$(zigzag_static_vk_pattern)"
  marker="$(zigzag_prewarm_marker)"
  zigzag_has_static_files "${param_pattern}" || return 1
  zigzag_has_static_files "${vk_pattern}" || return 1
  [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
  jq -e \
    --arg staticZigZagParamPattern "${param_pattern}" \
    --arg staticZigZagVkPattern "${vk_pattern}" \
    --arg sectorSize "${bench_sector_size}" \
    --argjson sectorSizeBytes "${bench_sector_size_bytes}" \
    '
    .schemaVersion == 1
    and .backend == "zigzag"
    and .sectorSize == $sectorSize
    and .sectorSizeBytes == $sectorSizeBytes
    and (.completedAt | type == "string")
    and .staticZigZagParamPattern == $staticZigZagParamPattern
    and .staticZigZagVkPattern == $staticZigZagVkPattern
    and .sidecarPolicy == "runtime-only-fresh-devnet"
    and ((.staticZigZagParamFiles | type) == "array")
    and ((.staticZigZagParamFiles | length) >= 1)
    and ((.staticZigZagVkFiles | type) == "array")
    and ((.staticZigZagVkFiles | length) >= 1)
  ' "${marker}" >/dev/null 2>&1
}

write_zigzag_prewarm_marker() {
  local marker param_pattern vk_pattern param_files vk_files file_count bytes temporary
  marker="$(zigzag_prewarm_marker)"
  param_pattern="$(zigzag_static_param_pattern)"
  vk_pattern="$(zigzag_static_vk_pattern)"
  param_files="$(zigzag_static_files_json "${param_pattern}")"
  vk_files="$(zigzag_static_files_json "${vk_pattern}")"
  file_count="$(proof_parameter_file_count)"
  bytes="$(proof_parameter_cache_bytes)"
  temporary="${marker}.temporary.$$"
  devnet_require_safe_write_path "${marker}" file
  devnet_require_safe_write_path "${temporary}" file
  jq -n \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sectorSize "${bench_sector_size}" \
    --argjson sectorSizeBytes "${bench_sector_size_bytes}" \
    --arg staticZigZagParamPattern "${param_pattern}" \
    --arg staticZigZagVkPattern "${vk_pattern}" \
    --argjson staticZigZagParamFiles "${param_files}" \
    --argjson staticZigZagVkFiles "${vk_files}" \
    --argjson proofParameterCacheFileCount "${file_count}" \
    --argjson proofParameterCacheBytes "${bytes}" \
    '{
      schemaVersion: 1,
      backend: "zigzag",
      sectorSize: $sectorSize,
      sectorSizeBytes: $sectorSizeBytes,
      completedAt: $completedAt,
      staticZigZagParamPattern: $staticZigZagParamPattern,
      staticZigZagVkPattern: $staticZigZagVkPattern,
      staticZigZagParamFiles: $staticZigZagParamFiles,
      staticZigZagVkFiles: $staticZigZagVkFiles,
      sidecarPolicy: "runtime-only-fresh-devnet",
      proofParameterCacheFileCount: $proofParameterCacheFileCount,
      proofParameterCacheBytes: $proofParameterCacheBytes,
      note: "Per-sector ZigZag proof sidecars are runtime artifacts and are intentionally excluded."
    }' > "${temporary}"
  mv -- "${temporary}" "${marker}"
}

record_run() {
  local backend="$1" repetition="$2" run_dir="$3" kind="$4"
  local summary="${run_dir}/summary.json"
  [[ -f "${summary}" && ! -L "${summary}" ]] ||
    devnet_die "benchmark summary is missing: ${summary}"
  jq -nc \
    --arg backend "${backend}" \
    --argjson repetition "${repetition}" \
    --arg kind "${kind}" \
    --arg runDir "${run_dir}" \
    --arg summaryPath "${summary}" \
    --slurpfile summary "${summary}" \
    '{
      backend:$backend,
      repetition:$repetition,
      kind:$kind,
      runDir:$runDir,
      summaryPath:$summaryPath,
      result:$summary[0].result,
      durationMs:$summary[0].durationMs,
      proofBackend:($summary[0].state.PROOF_BACKEND // ""),
      devnetProofBackend:($summary[0].state.DEVNET_PROOF_BACKEND // ""),
      devnetSectorSize:($summary[0].state.DEVNET_SECTOR_SIZE // $summary[0].state.STATUS_SECTOR_SIZE // ""),
      devnetSectorSizeBytes:($summary[0].state.DEVNET_SECTOR_SIZE_BYTES // $summary[0].state.STATUS_SECTOR_SIZE_BYTES // ""),
      proofParameterCacheStatus:($summary[0].state.PROOF_PARAMETER_CACHE_STATUS // ""),
      proofParameterCacheFileCount:($summary[0].state.PROOF_PARAMETER_CACHE_FILE_COUNT // ""),
      proofParameterCacheBytes:($summary[0].state.PROOF_PARAMETER_CACHE_BYTES // ""),
      curioCommit:($summary[0].state.DEVNET_CURIO_COMMIT // ""),
      lotusCommit:($summary[0].state.DEVNET_LOTUS_COMMIT // ""),
      curioImageId:($summary[0].state.IMAGE_CURIO_ID // ""),
      lotusImageId:($summary[0].state.IMAGE_LOTUS_ID // ""),
      dockerCpuCount:($summary[0].state.DOCKER_CPU_COUNT // ""),
      dockerTotalMemoryBytes:($summary[0].state.DOCKER_TOTAL_MEMORY_BYTES // ""),
      sourceSha256:($summary[0].state.SOURCE_SHA256 // ""),
      sectorNumber:($summary[0].state.SECTOR_NUMBER // "")
    }' >> "${records}"
}

prewarm_zigzag_if_needed() {
  [[ "${BENCH_PREWARM_PROOF_PARAMS:-1}" == 1 ]] || return 0
  if zigzag_static_params_ready; then
    jq -nc \
      --arg backend zigzag \
      --arg action skipped \
      --arg reason "ZigZag static Groth16 params/vk and prewarm marker are present" \
      --arg sectorSize "${bench_sector_size}" \
      --argjson sectorSizeBytes "${bench_sector_size_bytes}" \
      --arg marker "$(zigzag_prewarm_marker)" \
      --argjson proofParameterCacheFileCount "$(proof_parameter_file_count)" \
      --argjson proofParameterCacheBytes "$(proof_parameter_cache_bytes)" \
      '{backend:$backend,kind:"prewarm",action:$action,reason:$reason,sectorSize:$sectorSize,sectorSizeBytes:$sectorSizeBytes,marker:$marker,proofParameterCacheFileCount:$proofParameterCacheFileCount,proofParameterCacheBytes:$proofParameterCacheBytes}' >> "${records}"
    return 0
  fi

  devnet_progress "bench-proof-backends: prewarming ZigZag proof parameters outside measured benchmark windows"
  devnet_progress "bench-proof-backends: ZigZag prewarm: reset fresh devnet"
  just reset zigzag "${bench_sector_size}"
  devnet_progress "bench-proof-backends: ZigZag prewarm: deploy contracts"
  just deploy
  devnet_progress "bench-proof-backends: ZigZag prewarm: run correctness scenario"
  just test-deliver-seal-unseal-retrieval active
  local run_dir
  run_dir="$(latest_run_dir deliver-seal-unseal-retrieval)"
  record_run zigzag 0 "${run_dir}" prewarm
  write_zigzag_prewarm_marker
  devnet_progress "bench-proof-backends: ZigZag prewarm complete; report=${run_dir}/summary.md"
}

IFS=',' read -r -a requested_backends <<< "${backend_order}"
for raw_backend in "${requested_backends[@]}"; do
  backend="$(devnet_normalize_proof_backend "$(printf '%s' "${raw_backend}" | tr -d '[:space:]')")"
  prewarm_backend_params "${backend}"
  if [[ "${backend}" == zigzag ]]; then
    prewarm_zigzag_if_needed
  fi

  for repetition in $(seq 1 "${repetitions}"); do
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size} repetition ${repetition}/${repetitions}: reset fresh devnet"
    just reset "${backend}" "${bench_sector_size}"
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size} repetition ${repetition}/${repetitions}: deploy contracts"
    just deploy
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size} repetition ${repetition}/${repetitions}: run measured deliver/seal/unseal/retrieval benchmark"
    just bench-deliver-seal-unseal-retrieval active
    run_dir="$(latest_run_dir bench-deliver-seal-unseal-retrieval)"
    record_run "${backend}" "${repetition}" "${run_dir}" benchmark
    devnet_progress "bench-proof-backends: ${backend} ${bench_sector_size} repetition ${repetition}/${repetitions} complete; report=${run_dir}/summary.md"
  done
done

summary_json="${comparison_dir}/summary.json"
jq -s \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg backendOrder "${backend_order}" \
  --arg sectorSize "${bench_sector_size}" \
  --argjson sectorSizeBytes "${bench_sector_size_bytes}" \
  --argjson repetitions "${repetitions}" \
  '{
    schemaVersion:1,
    generatedAt:$generatedAt,
    backendOrder:$backendOrder,
    sectorSize:$sectorSize,
    sectorSizeBytes:$sectorSizeBytes,
    repetitions:$repetitions,
    runs:.
  }' "${records}" > "${summary_json}"

summary_md="${comparison_dir}/summary.md"
{
  printf '# Proof backend benchmark comparison\n\n'
  printf '| Backend | Repetition | Kind | Result | Duration | Proof path | Proof cache | Curio | Lotus | Docker | Sector | Report |\n'
  printf '| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |\n'
  jq -r '
    def dur($ms):
      if ($ms == null) then "not recorded"
      elif $ms < 1000 then (($ms|round|tostring) + " ms")
      elif $ms < 60000 then (((($ms / 1000) * 10 | round) / 10 | tostring) + " s")
      else (((($ms / 60000) * 10 | round) / 10 | tostring) + " min")
      end;
    def short($value): if ($value // "") == "" then "" else ($value[0:12]) end;
    def bytes($raw):
      ($raw | tonumber? // null) as $bytes
      | if $bytes == null then ""
        elif $bytes < 1024 then (($bytes|round|tostring) + " B")
        elif $bytes < 1048576 then (((($bytes / 1024) * 10 | round) / 10 | tostring) + " KiB")
        elif $bytes < 1073741824 then (((($bytes / 1048576) * 10 | round) / 10 | tostring) + " MiB")
        else (((($bytes / 1073741824) * 10 | round) / 10 | tostring) + " GiB")
        end;
    def cache:
      if (.proofParameterCacheStatus // "") != "" then "\(.proofParameterCacheStatus), \(.proofParameterCacheFileCount) files, \(bytes(.proofParameterCacheBytes))"
      elif (.proofParameterCacheFileCount // "") != "" then "\(.proofParameterCacheFileCount) files, \(bytes(.proofParameterCacheBytes))"
      else ""
      end;
    def docker:
      if (.dockerCpuCount // "") == "" and (.dockerTotalMemoryBytes // "") == "" then ""
      else "\(.dockerCpuCount) CPUs, \(bytes(.dockerTotalMemoryBytes))"
      end;
    .runs[]
    | (if (.runDir // "") == "" then "" else "[summary.md](\(.runDir)/summary.md)" end) as $report
    | (.reason // "") as $reason
    | (((.devnetSectorSize // .sectorSize // "") | tostring) + if (.sectorNumber // "") == "" then "" else " / sector \(.sectorNumber)" end) as $sector
    | "| \(.backend) | \(.repetition // "") | \(.kind) | \(.result // .action // "not recorded") | \(dur(.durationMs)) | \(.proofBackend // "") | \(cache) | \(short(.curioCommit))/\(short(.curioImageId)) | \(short(.lotusCommit))/\(short(.lotusImageId)) | \(docker) | \($sector) | \(if $report == "" then $reason else $report end) |"
  ' "${summary_json}"
  printf '\nFull machine-readable comparison: [`summary.json`](./summary.json).\n'
} > "${summary_md}"

printf 'backend benchmark comparison: %s\n' "${summary_md}"
