#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command jq

backend="$(devnet_normalize_proof_backend "${1:-${DEVNET_PROOF_BACKEND:-stacked}}")"
sector_size="${2:-${DEVNET_SECTOR_SIZE:-8mib}}"

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
run_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-bench-proof-micro-${backend}-${safe_sector}"
devnet_require_safe_write_path "${DEVNET_ROOT}/.runtime/runs" directory
devnet_require_safe_write_path "${run_dir}" directory
mkdir -p "${run_dir}"

summary_json="${run_dir}/summary.json"
prewarm_summary_json="${run_dir}/param-prewarm.json"
prewarm_stderr_log="${run_dir}/param-prewarm.stderr.log"
stderr_log="${run_dir}/stderr.log"
work_dir="${run_dir}/work"
parameter_cache_host="${DEVNET_PROOF_PARAMETERS_DIR}"
if [[ "${backend}" == "stacked" ]]; then
  parameter_cache_host="${run_dir}/stacked-proof-parameter-cache"
fi
mkdir -p "${work_dir}"
mkdir -p "${parameter_cache_host}"

devnet_progress "bench-proof-micro: backend=${backend} sector_size=${sector_size} image=${image}"
if [[ "${backend}" == "stacked" ]]; then
  devnet_progress "bench-proof-micro: using isolated Stacked parameter cache at ${parameter_cache_host}"
  devnet_progress "bench-proof-micro: Stacked SDR replication=${stacked_sdr_replication_mode} FIL_PROOFS_USE_MULTICORE_SDR=${stacked_multicore_sdr_requested}"
fi
devnet_progress "bench-proof-micro: prewarming ${backend} PoRep params for ${sector_size} outside measured phases"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e "FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters" \
  -e "FIL_PROOFS_USE_ZIGZAG=$(devnet_fil_proofs_use_zigzag "${backend}")" \
  -e "FIL_PROOFS_USE_MULTICORE_SDR=${stacked_multicore_sdr_requested}" \
  -e "FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/tmp/filecoin-zigzag-proof-sidecars" \
  -e "POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=${POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS:-0}" \
  -v "${parameter_cache_host}:/var/tmp/filecoin-proof-parameters:rw" \
  -v "${run_dir}:/bench-run:rw" \
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
  --user "$(id -u):$(id -g)" \
  -e "FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters" \
  -e "FIL_PROOFS_USE_ZIGZAG=$(devnet_fil_proofs_use_zigzag "${backend}")" \
  -e "FIL_PROOFS_USE_MULTICORE_SDR=${stacked_multicore_sdr_requested}" \
  -e "FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/tmp/filecoin-zigzag-proof-sidecars" \
  -e "POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=${POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS:-0}" \
  -v "${parameter_cache_host}:/var/tmp/filecoin-proof-parameters:rw" \
  -v "${run_dir}:/bench-run:rw" \
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
      "| Stacked SDR replication | `" + $stackedSdrReplicationMode + "` |",
      "| FIL_PROOFS_USE_MULTICORE_SDR | `" + $filProofsUseMulticoreSdr + "` |",
      "| Proof length | `" + (.proof_len | tostring) + "` bytes |",
      "| Verify seal | `" + (.verify_seal | tostring) + "` |",
      "| Raw unseal bytes match | `" + (.raw_unseal_bytes_match | tostring) + "` |",
      "| Proof parameter cache | `" + .proof_parameter_cache + "` |",
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
