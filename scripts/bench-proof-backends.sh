#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command jq
devnet_require_command just

backend_order="${BENCH_BACKEND_ORDER:-zigzag,stacked}"
repetitions="${BENCH_REPETITIONS:-1}"
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
  if [[ ! -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]]; then
    printf '0\n'
    return 0
  fi
  find "${DEVNET_PROOF_PARAMETERS_DIR}" -type f | wc -l | tr -d '[:space:]'
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
      sector:($summary[0].state.SECTOR_NUMBER // "")
    }' >> "${records}"
}

prewarm_zigzag_if_needed() {
  [[ "${BENCH_PREWARM_PROOF_PARAMS:-1}" == 1 ]] || return 0
  if [[ "$(proof_parameter_file_count)" != 0 ]]; then
    jq -nc --arg backend zigzag --arg action skipped --arg reason "proof parameter cache already contains files" \
      '{backend:$backend,kind:"prewarm",action:$action,reason:$reason}' >> "${records}"
    return 0
  fi

  printf 'prewarming ZigZag proof parameters outside measured benchmark windows\n'
  just reset zigzag
  just deploy
  just test-deliver-seal-unseal-retrieval active
  local run_dir
  run_dir="$(latest_run_dir deliver-seal-unseal-retrieval)"
  record_run zigzag 0 "${run_dir}" prewarm
}

IFS=',' read -r -a requested_backends <<< "${backend_order}"
for raw_backend in "${requested_backends[@]}"; do
  backend="$(devnet_normalize_proof_backend "$(printf '%s' "${raw_backend}" | tr -d '[:space:]')")"
  if [[ "${backend}" == zigzag ]]; then
    prewarm_zigzag_if_needed
  fi

  for repetition in $(seq 1 "${repetitions}"); do
    printf 'running %s benchmark repetition %s/%s\n' "${backend}" "${repetition}" "${repetitions}"
    just reset "${backend}"
    just deploy
    just bench-deliver-seal-unseal-retrieval active
    run_dir="$(latest_run_dir bench-deliver-seal-unseal-retrieval)"
    record_run "${backend}" "${repetition}" "${run_dir}" benchmark
  done
done

summary_json="${comparison_dir}/summary.json"
jq -s \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg backendOrder "${backend_order}" \
  --argjson repetitions "${repetitions}" \
  '{
    schemaVersion:1,
    generatedAt:$generatedAt,
    backendOrder:$backendOrder,
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
      if (.proofParameterCacheStatus // "") == "" then ""
      else "\(.proofParameterCacheStatus), \(.proofParameterCacheFileCount) files, \(bytes(.proofParameterCacheBytes))"
      end;
    def docker:
      if (.dockerCpuCount // "") == "" and (.dockerTotalMemoryBytes // "") == "" then ""
      else "\(.dockerCpuCount) CPUs, \(bytes(.dockerTotalMemoryBytes))"
      end;
    .runs[]
    | "| \(.backend) | \(.repetition) | \(.kind) | \(.result // "not recorded") | \(dur(.durationMs)) | \(.proofBackend // "") | \(cache) | \(short(.curioCommit))/\(short(.curioImageId)) | \(short(.lotusCommit))/\(short(.lotusImageId)) | \(docker) | \(.sector // "") | [summary.md](\(.runDir)/summary.md) |"
  ' "${summary_json}"
  printf '\nFull machine-readable comparison: [`summary.json`](./summary.json).\n'
} > "${summary_md}"

printf 'backend benchmark comparison: %s\n' "${summary_md}"
