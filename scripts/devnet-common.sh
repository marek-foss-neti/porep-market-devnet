#!/usr/bin/env bash

DEVNET_COMMON_DIRECTORY="$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
[[ "${DEVNET_COMMON_DIRECTORY##*/}" == scripts ]] || {
  printf 'error: lifecycle scripts must remain under the repository scripts directory\n' >&2
  exit 1
}
DEVNET_ROOT="${DEVNET_COMMON_DIRECTORY%/scripts}"
DEVNET_RUNTIME_DIR="${DEVNET_ROOT}/.runtime/devnet"
DEVNET_BUILD_DIR="${DEVNET_RUNTIME_DIR}/build"
DEVNET_LOG_DIR="${DEVNET_RUNTIME_DIR}/logs"
DEVNET_IMAGE_NAMESPACE="porep-market-curio-devnet"
DEVNET_BUILD_TIMEOUT_MS=5400000
DEVNET_PROJECT="porep-market-curio-devnet"
DEVNET_COMPOSE="${DEVNET_ROOT}/docker/compose.curio-devnet.yaml"
DEVNET_COMPOSE_ENV="${DEVNET_RUNTIME_DIR}/compose.env"
DEVNET_DATA_DIR="${DEVNET_RUNTIME_DIR}/data"
DEVNET_PROOF_BACKEND_FILE="${DEVNET_RUNTIME_DIR}/proof-backend"
DEVNET_SECTOR_SIZE_FILE="${DEVNET_RUNTIME_DIR}/sector-size"
DEVNET_PROOF_PARAMETERS_DIR="${DEVNET_ROOT}/.cache/proof-parameters"
DEVNET_ZIGZAG_SIDECAR_DIR="${DEVNET_RUNTIME_DIR}/zigzag-proof-sidecars"
DEVNET_LIFECYCLE_TIMEOUT_MS=120000
DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS="${DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS:-}"
DEVNET_PROGRESS_INTERVAL_SECONDS="${DEVNET_PROGRESS_INTERVAL_SECONDS:-15}"
DEVNET_SERVICES=(lotus contracts-bootstrap lotus-miner curio yugabyte piece-server indexer)
DEVNET_DATA_DIRECTORIES=(lotus lotus-miner curio piece-server indexer contracts genesis yugabyte yugabyte-disk0 yugabyte-disk1)

devnet_progress_enabled() {
  [[ -z "${DEVNET_TEST_COMMAND_LOG:-}" ]] || return 1
  [[ "${DEVNET_PROGRESS:-1}" != 0 ]] || return 1
  return 0
}

devnet_progress_interval_seconds() {
  local interval="${DEVNET_PROGRESS_INTERVAL_SECONDS:-15}"
  if [[ ! "${interval}" =~ ^[0-9]+$ ]]; then
    interval=15
  elif ((interval < 1)); then
    interval=15
  fi
  printf '%s\n' "${interval}"
}

devnet_progress() {
  devnet_progress_enabled || return 0
  printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2
}

devnet_progress_maybe() {
  local last_variable="$1"
  shift
  devnet_progress_enabled || return 0
  local interval now last
  interval="$(devnet_progress_interval_seconds)"
  now="${SECONDS}"
  last="${!last_variable-0}"
  if ((now - last >= interval)); then
    printf -v "${last_variable}" '%s' "${now}"
    devnet_progress "$*"
  fi
}

devnet_format_duration_seconds() {
  local seconds="${1:-0}"
  [[ "${seconds}" =~ ^[0-9]+$ ]] || seconds=0
  if ((seconds < 60)); then
    printf '%ss\n' "${seconds}"
  elif ((seconds < 3600)); then
    printf '%sm%02ss\n' "$((seconds / 60))" "$((seconds % 60))"
  else
    printf '%sh%02sm%02ss\n' "$((seconds / 3600))" "$(((seconds % 3600) / 60))" "$((seconds % 60))"
  fi
}

devnet_format_bytes() {
  local bytes="${1:-0}"
  awk -v bytes="${bytes}" 'BEGIN {
    if (bytes < 1024) {
      printf "%d B", bytes
    } else if (bytes < 1048576) {
      printf "%.1f KiB", bytes / 1024
    } else if (bytes < 1073741824) {
      printf "%.1f MiB", bytes / 1048576
    } else {
      printf "%.1f GiB", bytes / 1073741824
    }
  }'
}

devnet_proof_parameter_file_count() {
  if [[ ! -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]]; then
    printf '0\n'
    return 0
  fi
  find "${DEVNET_PROOF_PARAMETERS_DIR}" \
    -path "${DEVNET_PROOF_PARAMETERS_DIR}/zigzag-proof-sidecars" -prune -o \
    -type f -print | wc -l | tr -d '[:space:]'
}

devnet_proof_parameter_cache_bytes() {
  if [[ ! -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]]; then
    printf '0\n'
    return 0
  fi
  find "${DEVNET_PROOF_PARAMETERS_DIR}" \
    -path "${DEVNET_PROOF_PARAMETERS_DIR}/zigzag-proof-sidecars" -prune -o \
    -type f -exec sh -c '
      for path do
        stat -f "%z" "$path" 2>/dev/null || stat -c "%s" "$path"
      done
    ' sh {} + |
    awk '{sum += $1} END {printf "%d\n", sum + 0}'
}

devnet_proof_parameter_cache_label() {
  local files bytes
  files="$(devnet_proof_parameter_file_count)"
  bytes="$(devnet_proof_parameter_cache_bytes)"
  printf '%s files, %s\n' "${files}" "$(devnet_format_bytes "${bytes}")"
}

devnet_recent_proof_parameter_label() {
  [[ -d "${DEVNET_PROOF_PARAMETERS_DIR}" ]] || return 0
  local path size
  path="$(find "${DEVNET_PROOF_PARAMETERS_DIR}" \
    -path "${DEVNET_PROOF_PARAMETERS_DIR}/zigzag-proof-sidecars" -prune -o \
    -type f -exec ls -t {} + 2>/dev/null | head -n1 || true)"
  [[ -n "${path}" ]] || return 0
  size="$(stat -f "%z" "${path}" 2>/dev/null || stat -c "%s" "${path}" 2>/dev/null || printf '0')"
  printf '%s (%s)\n' "$(basename "${path}")" "$(devnet_format_bytes "${size}")"
}

devnet_file_md5() {
  local path="$1"
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "${path}"
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "${path}" | awk '{print $1}'
  else
    devnet_die "required command not found: md5 or md5sum"
  fi
}

devnet_official_parameters_manifest() {
  local image_manifest commit source manifest
  image_manifest="${DEVNET_BUILD_DIR}/images.json"
  commit=""
  if [[ -f "${image_manifest}" && ! -L "${image_manifest}" ]]; then
    commit="$(jq -r '.rustFilProofsCommit // empty' "${image_manifest}")"
  fi
  source="$(devnet_rust_fil_proofs_source_path "${commit}")"
  manifest="${source}/parameters.json"
  [[ -f "${manifest}" && ! -L "${manifest}" ]] ||
    devnet_die "official Filecoin proof parameter manifest is missing: ${manifest}"
  printf '%s\n' "${manifest}"
}

devnet_quarantine_mismatched_stacked_parameter_cache() {
  local sector_size sector_size_bytes candidate_metadata manifest key expected path metadata_path base actual
  local quarantine_dir moved_bases moved_count
  [[ -d "${DEVNET_PROOF_PARAMETERS_DIR}" && ! -L "${DEVNET_PROOF_PARAMETERS_DIR}" ]] || return 0
  sector_size="$(devnet_requested_sector_size "${1:-}")"
  sector_size_bytes="$(devnet_sector_size_bytes "${sector_size}")"
  candidate_metadata="$(find "${DEVNET_PROOF_PARAMETERS_DIR}" -maxdepth 1 -type f -name 'v28-stacked-proof-of-replication-*.meta' -print -quit)"
  [[ -n "${candidate_metadata}" ]] || return 0
  manifest="$(devnet_official_parameters_manifest)"
  quarantine_dir=""
  moved_bases=""
  moved_count=0

  while IFS=$'\t' read -r key expected; do
    [[ -n "${key}" && "${key}" != */* && "${expected}" =~ ^[0-9a-f]{32}$ ]] ||
      devnet_die "invalid Stacked parameter manifest entry"
    path="${DEVNET_PROOF_PARAMETERS_DIR}/${key}"
    base="${key%.*}"
    metadata_path="${DEVNET_PROOF_PARAMETERS_DIR}/${base}.meta"
    [[ -f "${metadata_path}" && ! -L "${metadata_path}" ]] || continue
    [[ -e "${path}" || -L "${path}" ]] || continue
    [[ -f "${path}" && ! -L "${path}" ]] ||
      devnet_die "proof parameter cache entry must be a regular file: ${path}"
    actual="$(devnet_file_md5 "${path}")"
    [[ "${actual}" != "${expected}" ]] || continue

    if [[ -z "${quarantine_dir}" ]]; then
      quarantine_dir="${DEVNET_ROOT}/.runtime/proof-parameter-quarantine/$(date -u +%Y%m%dT%H%M%SZ)-$$-${sector_size}"
      devnet_require_safe_write_path "${DEVNET_ROOT}/.runtime/proof-parameter-quarantine" directory
      devnet_require_safe_write_path "${quarantine_dir}" directory
      mkdir -p "${quarantine_dir}"
    fi
    devnet_progress "devnet-up: quarantining non-production Stacked proof parameter ${key} (md5 ${actual} != ${expected})"
    mv -- "${path}" "${quarantine_dir}/${key}"
    moved_bases="${moved_bases}${base}"$'\n'
    moved_count=$((moved_count + 1))
  done < <(
    jq -r --argjson sectorSize "${sector_size_bytes}" '
      to_entries[]
      | select((.key | startswith("v28-stacked-proof-of-replication-"))
        and (.value.sector_size == $sectorSize)
        and (.value.digest | type == "string"))
      | [.key, .value.digest] | @tsv
    ' "${manifest}"
  )

  if [[ -n "${quarantine_dir}" ]]; then
    while IFS= read -r base; do
      [[ -n "${base}" && "${base}" != */* ]] || continue
      metadata_path="${DEVNET_PROOF_PARAMETERS_DIR}/${base}.meta"
      if [[ -f "${metadata_path}" && ! -L "${metadata_path}" ]]; then
        mv -- "${metadata_path}" "${quarantine_dir}/$(basename "${metadata_path}")"
      fi
    done < <(printf '%s' "${moved_bases}" | awk 'NF && !seen[$0]++')
    devnet_progress "devnet-up: quarantined ${moved_count} non-production Stacked proof parameter file(s) to ${quarantine_dir}"
  fi
}

devnet_last_nonempty_line() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" ]] || return 0
  awk 'NF {line=$0} END {if (line != "") print line}' "${path}" | tail -n1 | cut -c1-180
}

devnet_start_prewarm_progress() {
  local result_variable="$1"
  local label="$2"
  local stderr_log="${3:-}"
  printf -v "${result_variable}" ''
  devnet_progress_enabled || return 0
  (
    interval="$(devnet_progress_interval_seconds)"
    started="${SECONDS}"
    keep_reporting=1
    while ((keep_reporting)); do
      sleep "${interval}"
      elapsed="$((SECONDS - started))"
      message="${label}: still running after $(devnet_format_duration_seconds "${elapsed}"); cache=$(devnet_proof_parameter_cache_label)"
      latest="$(devnet_recent_proof_parameter_label)"
      [[ -z "${latest}" ]] || message="${message}; latest=${latest}"
      last_line="$(devnet_last_nonempty_line "${stderr_log}")"
      [[ -z "${last_line}" ]] || message="${message}; last=${last_line}"
      devnet_progress "${message}"
    done
  ) >/dev/null &
  printf -v "${result_variable}" '%s' "$!"
}

devnet_stop_prewarm_progress() {
  local progress_pid="${1:-}"
  [[ -n "${progress_pid}" ]] || return 0
  kill "${progress_pid}" 2>/dev/null || true
  wait "${progress_pid}" 2>/dev/null || true
}

devnet_compose() {
  env -u DEVNET_IMAGE_NAMESPACE -u DEVNET_CURIO_SHORT_COMMIT -u DEVNET_DATA_DIR \
    -u DEVNET_PROOF_BACKEND -u DEVNET_SECTOR_SIZE -u DEVNET_PROOF_PARAMETERS_DIR -u DEVNET_PARENT_CACHE_DIR -u DEVNET_ZIGZAG_SIDECAR_DIR -u DEVNET_FIREHORSE_HEIGHT \
    -u DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS \
    -u DEVNET_FILECOIN_SERVICES_SOURCE -u DEVNET_MULTICALL3_SOURCE \
    -u DEVNET_YUGABYTE_IMAGE -u LOTUS_FIREHORSE_HEIGHT -u LOTUS_DEVNET_NETWORK_BUNDLE -u SECTOR_SIZE -u FIL_PROOFS_USE_ZIGZAG \
    -u FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS -u FIL_PROOFS_ZIGZAG_SIDECAR_DIR -u FIL_PROOFS_PARENT_CACHE \
    -u FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE -u FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE -u FIL_PROOFS_SDR_PARENTS_CACHE_SIZE \
    docker compose --env-file "${DEVNET_COMPOSE_ENV}" --project-name "${DEVNET_PROJECT}" --file "${DEVNET_COMPOSE}" "$@"
}

devnet_normalize_proof_backend() {
  local value="${1:-stacked}"
  case "${value}" in
    ""|stacked|sdr) printf 'stacked\n' ;;
    zigzag) printf 'zigzag\n' ;;
    *) devnet_die "invalid proof backend: ${value}; expected stacked or zigzag" ;;
  esac
}

devnet_requested_proof_backend() {
  devnet_normalize_proof_backend "${1:-${DEVNET_PROOF_BACKEND:-stacked}}"
}

devnet_normalize_sector_size() {
  local value="${1:-8mib}"
  value="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  value="${value//_/}"
  value="${value//-/}"
  value="${value// /}"
  value="${value/kb/kib}"
  value="${value/mb/mib}"
  value="${value/gb/gib}"
  case "${value}" in
    ""|8mib) printf '8mib\n' ;;
    2kib) printf '2kib\n' ;;
    512mib) printf '512mib\n' ;;
    32gib) printf '32gib\n' ;;
    2mib|1gib|2gib|4gib|8gib)
      devnet_die "${value} is not a Filecoin registered seal proof sector size; expected 2kib, 8mib, 512mib, or 32gib"
      ;;
    64gib)
      devnet_die "64gib is a registered Filecoin sector size, but this branch wires ZigZag large-sector testing for 512mib and 32gib only"
      ;;
    *) devnet_die "invalid sector size: ${1}; expected 2kib, 8mib, 512mib, or 32gib" ;;
  esac
}

devnet_requested_sector_size() {
  devnet_normalize_sector_size "${1:-${DEVNET_SECTOR_SIZE:-8mib}}"
}

devnet_curio_market_config_timeout_seconds() {
  local sector_size="${1:-8mib}"
  local configured="${DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS:-}"
  if [[ -n "${configured}" ]]; then
    [[ "${configured}" =~ ^[0-9]+$ ]] || devnet_die "DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS must be a positive integer"
    ((configured > 0)) || devnet_die "DEVNET_CURIO_MARKET_CONFIG_TIMEOUT_SECONDS must be a positive integer"
    printf '%s\n' "${configured}"
    return 0
  fi

  case "${sector_size}" in
    512mib|32gib) printf '14400\n' ;;
    *) printf '300\n' ;;
  esac
}

devnet_sector_size_bytes() {
  local value
  value="$(devnet_normalize_sector_size "$1")"
  case "${value}" in
    2kib) printf '2048\n' ;;
    8mib) printf '8388608\n' ;;
    512mib) printf '536870912\n' ;;
    32gib) printf '34359738368\n' ;;
    *) devnet_die "invalid normalized sector size: ${value}" ;;
  esac
}

devnet_registered_seal_proof_for_sector_size() {
  local value
  value="$(devnet_normalize_sector_size "$1")"
  case "${value}" in
    2kib) printf 'StackedDrg2KiBV1_1\n' ;;
    8mib) printf 'StackedDrg8MiBV1_1\n' ;;
    512mib) printf 'StackedDrg512MiBV1_1\n' ;;
    32gib) printf 'StackedDrg32GiBV1_1\n' ;;
    *) devnet_die "invalid normalized sector size: ${value}" ;;
  esac
}

devnet_actor_network_bundle_for_sector_size() {
  local value
  value="$(devnet_normalize_sector_size "$1")"
  case "${value}" in
    2kib|8mib) printf 'devnet\n' ;;
    512mib|32gib) printf 'testing\n' ;;
    *) devnet_die "unsupported sector size: ${value}" ;;
  esac
}

devnet_disable_actor_metadata_tasks_for_sector_size() {
  local value
  value="$(devnet_normalize_sector_size "$1")"
  case "${value}" in
    2kib|8mib) printf '0\n' ;;
    512mib|32gib) printf '1\n' ;;
    *) devnet_die "unsupported sector size: ${value}" ;;
  esac
}

devnet_fil_proofs_use_zigzag() {
  local backend
  backend="$(devnet_normalize_proof_backend "$1")"
  [[ "${backend}" == zigzag ]] && printf '1\n' || printf '0\n'
}

devnet_fil_proofs_zigzag_generate_missing_params() {
  local backend
  backend="$(devnet_normalize_proof_backend "$1")"
  [[ "${backend}" == zigzag ]] && printf '1\n' || printf '0\n'
}

devnet_parent_cache_dir_for_backend() {
  local backend
  backend="$(devnet_normalize_proof_backend "$1")"
  if [[ "${backend}" == "zigzag" ]]; then
    printf '%s\n' "${DEVNET_ROOT}/.cache/zigzag-parent-cache"
  else
    printf '%s\n' "${DEVNET_ROOT}/.cache/stacked-parent-cache"
  fi
}

devnet_parent_cache_window_nodes() {
  local value="${DEVNET_PARENT_CACHE_WINDOW_NODES:-2048}"
  [[ "${value}" =~ ^[0-9]+$ && "${value}" -ge 1 ]] ||
    devnet_die "DEVNET_PARENT_CACHE_WINDOW_NODES must be a positive integer"
  printf '%s\n' "${value}"
}

devnet_firehorse_upgrade_epoch() {
  local value
  value="$(awk -F ':' '$1 ~ /^[[:space:]]*firehorse_upgrade_epoch[[:space:]]*$/ {
    gsub(/[[:space:]]/, "", $2)
    print $2
    exit
  }' "${DEVNET_ROOT}/versions.lock.yaml")"
  [[ "${value}" =~ ^[0-9]+$ && "${value}" -ge 1 ]] ||
    devnet_die "FireHorse upgrade epoch is missing or invalid in versions.lock.yaml"
  printf '%s\n' "${value}"
}

devnet_firehorse_upgrade_epoch_for_sector_size() {
  local sector_size configured
  sector_size="$(devnet_normalize_sector_size "$1")"
  configured="${DEVNET_FIREHORSE_UPGRADE_EPOCH:-}"
  if [[ -n "${configured}" ]]; then
    [[ "${configured}" =~ ^[0-9]+$ && "${configured}" -ge 1 ]] ||
      devnet_die "DEVNET_FIREHORSE_UPGRADE_EPOCH must be a positive integer"
    printf '%s\n' "${configured}"
    return 0
  fi
  case "${sector_size}" in
    512mib|32gib) printf '200\n' ;;
    *) devnet_firehorse_upgrade_epoch ;;
  esac
}

devnet_write_proof_backend() {
  local backend temporary
  backend="$(devnet_normalize_proof_backend "$1")"
  devnet_require_safe_write_path "${DEVNET_PROOF_BACKEND_FILE}" file
  temporary="${DEVNET_PROOF_BACKEND_FILE}.temporary.$$"
  devnet_require_safe_write_path "${temporary}" file
  (set -o noclobber; printf '%s\n' "${backend}" > "${temporary}") ||
    devnet_die "failed to create proof backend marker"
  mv -- "${temporary}" "${DEVNET_PROOF_BACKEND_FILE}"
}

devnet_current_proof_backend() {
  local value
  [[ -f "${DEVNET_PROOF_BACKEND_FILE}" && ! -L "${DEVNET_PROOF_BACKEND_FILE}" ]] ||
    devnet_die "proof backend marker is missing; run just reset stacked 8mib or just reset zigzag 8mib"
  value="$(tr -d '\r\n[:space:]' < "${DEVNET_PROOF_BACKEND_FILE}")"
  devnet_normalize_proof_backend "${value}"
}

devnet_write_sector_size() {
  local sector_size temporary
  sector_size="$(devnet_normalize_sector_size "$1")"
  devnet_require_safe_write_path "${DEVNET_SECTOR_SIZE_FILE}" file
  temporary="${DEVNET_SECTOR_SIZE_FILE}.temporary.$$"
  devnet_require_safe_write_path "${temporary}" file
  (set -o noclobber; printf '%s\n' "${sector_size}" > "${temporary}") ||
    devnet_die "failed to create sector size marker"
  mv -- "${temporary}" "${DEVNET_SECTOR_SIZE_FILE}"
}

devnet_current_sector_size() {
  local value
  [[ -f "${DEVNET_SECTOR_SIZE_FILE}" && ! -L "${DEVNET_SECTOR_SIZE_FILE}" ]] ||
    devnet_die "sector size marker is missing; run just reset stacked 8mib or just reset zigzag 8mib"
  value="$(tr -d '\r\n[:space:]' < "${DEVNET_SECTOR_SIZE_FILE}")"
  devnet_normalize_sector_size "${value}"
}

devnet_require_runtime_identity() {
  local requested_backend current_backend requested_sector_size current_sector_size existing_containers
  requested_backend="$(devnet_requested_proof_backend "${1:-}")"
  requested_sector_size="$(devnet_requested_sector_size "${2:-}")"
  if [[ -f "${DEVNET_PROOF_BACKEND_FILE}" && ! -L "${DEVNET_PROOF_BACKEND_FILE}" ]]; then
    current_backend="$(devnet_current_proof_backend)"
    [[ "${current_backend}" == "${requested_backend}" ]] ||
      devnet_die "existing runtime uses proof backend ${current_backend}; run just reset ${requested_backend} ${requested_sector_size} to switch"
    current_sector_size="$(devnet_current_sector_size)"
    [[ "${current_sector_size}" == "${requested_sector_size}" ]] ||
      devnet_die "existing runtime uses sector size ${current_sector_size}; run just reset ${requested_backend} ${requested_sector_size} to switch"
    return 0
  fi
  existing_containers="$(devnet_compose ps --all --quiet 2>/dev/null || true)"
  [[ -z "${existing_containers//[[:space:]]/}" ]] ||
    devnet_die "existing runtime has no proof backend marker; run just reset ${requested_backend} ${requested_sector_size}"
  devnet_write_proof_backend "${requested_backend}"
  devnet_write_sector_size "${requested_sector_size}"
}

devnet_write_compose_env() {
  local source_output curio_commit lotus_commit blst_commit rust_fil_proofs_commit services_commit multicall_commit
  local manifest_zigzag_overrides manifest_zigzag_api
  source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
  curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
  lotus_commit="$(awk -F '\t' '$1 == "lotus" {print $3}' <<<"${source_output}")"
  blst_commit="$(awk -F '\t' '$1 == "blst" {print $3}' <<<"${source_output}")"
  rust_fil_proofs_commit="$(awk -F '\t' '$1 == "rust_fil_proofs" {print $3}' <<<"${source_output}")"
  services_commit="$(awk -F '\t' '$1 == "filecoin_services" {print $3}' <<<"${source_output}")"
  multicall_commit="$(awk -F '\t' '$1 == "multicall3" {print $3}' <<<"${source_output}")"
  [[ "${curio_commit}" =~ ^[0-9a-f]{40}$ && "${lotus_commit}" =~ ^[0-9a-f]{40}$ && "${blst_commit}" =~ ^[0-9a-f]{40}$ && "${rust_fil_proofs_commit}" =~ ^[0-9a-f]{40}$ && "${services_commit}" =~ ^[0-9a-f]{40}$ && "${multicall_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "verified managed source contract is incomplete"
  local image_manifest="${DEVNET_BUILD_DIR}/images.json"
  [[ -f "${image_manifest}" && ! -L "${image_manifest}" ]] || devnet_die "verified image manifest is missing"
  [[ "$(jq -r '.schemaVersion' "${image_manifest}")" == 1 && "$(jq -r '.namespace' "${image_manifest}")" == "${DEVNET_IMAGE_NAMESPACE}" && "$(jq -r '.tag' "${image_manifest}")" == "${curio_commit:0:12}" ]] || devnet_die "image manifest identity is invalid"
  manifest_lotus="$(jq -r '.lotusCommit' "${image_manifest}")"
  manifest_blst="$(jq -r '.blstCommit' "${image_manifest}")"
  manifest_rust_fil_proofs="$(jq -r '.rustFilProofsCommit // empty' "${image_manifest}")"
  manifest_hash="$(jq -r '.dockerfileSha256' "${image_manifest}")"
  manifest_zigzag_overrides="$(jq -r '.zigzagSourceOverridesSha256 // empty' "${image_manifest}")"
  manifest_zigzag_api="$(jq -r '.zigzagRustFilProofsApiSha256 // empty' "${image_manifest}")"
  manifest_platform="$(jq -r '.platform' "${image_manifest}")"
  [[ "${manifest_lotus}" =~ ^[0-9a-f]{40}$ && "${manifest_blst}" =~ ^[0-9a-f]{40}$ && "${manifest_rust_fil_proofs}" =~ ^[0-9a-f]{40}$ && "${manifest_hash}" =~ ^[0-9a-f]{64}$ && "${manifest_zigzag_overrides}" =~ ^[0-9a-f]{64}$ && "${manifest_zigzag_api}" =~ ^[0-9a-f]{64}$ && "${manifest_platform}" =~ ^linux/(amd64|arm64)$ ]] || devnet_die "image manifest fields are invalid"
  [[ "${manifest_lotus}" == "${lotus_commit}" && "${manifest_blst}" == "${blst_commit}" && "${manifest_rust_fil_proofs}" == "${rust_fil_proofs_commit}" ]] || devnet_die "image manifest source commits do not match verified sources"
  [[ "$(devnet_docker_surface_sha256)" == "${manifest_hash}" ]] || devnet_die "image manifest Dockerfile hash mismatch"
  [[ "$(devnet_zigzag_source_overrides_sha256)" == "${manifest_zigzag_overrides}" ]] || devnet_die "image manifest ZigZag source override hash mismatch"
  [[ "$(devnet_rust_fil_proofs_zigzag_api_sha256 "${rust_fil_proofs_commit}")" == "${manifest_zigzag_api}" ]] || devnet_die "image manifest ZigZag rust-fil-proofs API hash mismatch"
  grep -Fq "\"curioCommit\": \"${curio_commit}\"" "${image_manifest}" || devnet_die "image manifest Curio commit mismatch"
  for image in curio-all-in-one lotus contracts-bootstrap lotus-miner curio piece-server indexer; do
    grep -Fq "\"reference\": \"${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}\"" "${image_manifest}" || devnet_die "image manifest is missing ${image}"
    docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" >/dev/null || devnet_die "required image is missing: ${image}"
    actual_id="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{.Id}}')"
    expected_id="$(jq -r --arg ref "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" '.images[] | select(.reference == $ref) | .id' "${image_manifest}")"
    [[ "${actual_id}" == "${expected_id}" ]] || devnet_die "image ID mismatch: ${image}"
    actual_commit="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.curio.commit"}}')"
    [[ "${actual_commit}" == "${curio_commit}" ]] || devnet_die "image Curio label mismatch: ${image}"
    actual_lotus="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.lotus.commit"}}')"
    actual_blst="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.blst.commit"}}')"
    actual_dockerfile="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.dockerfile.sha256"}}')"
    actual_rust_fil_proofs="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.zigzag.rust-fil-proofs.commit"}}')"
    actual_zigzag_overrides="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.zigzag.source-overrides.sha256"}}')"
    actual_zigzag_api="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.zigzag.rust-fil-proofs.api.sha256"}}')"
    [[ "${actual_lotus}" == "${manifest_lotus}" && "${actual_blst}" == "${manifest_blst}" && "${actual_dockerfile}" == "${manifest_hash}" && "${actual_rust_fil_proofs}" == "${manifest_rust_fil_proofs}" && "${actual_zigzag_overrides}" == "${manifest_zigzag_overrides}" && "${actual_zigzag_api}" == "${manifest_zigzag_api}" ]] || devnet_die "image identity labels mismatch: ${image}"
    [[ "$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{.Os}}/{{.Architecture}}')" == "${manifest_platform}" ]] || devnet_die "image platform mismatch: ${image}"
    [[ "$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{json .Config.Volumes}}')" == null ]] || devnet_die "image declares unexpected volumes: ${image}"
  done
  docker image inspect 'yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8' >/dev/null || devnet_die "required Yugabyte image is missing"
  [[ "$(docker image inspect 'yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8' --format '{{.Os}}/{{.Architecture}}')" == "${manifest_platform}" ]] || devnet_die "Yugabyte platform mismatch"
  yugabyte_volumes="$(docker image inspect 'yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8' --format '{{json .Config.Volumes}}')"
  [[ "${yugabyte_volumes}" == '{"/mnt/disk0":{},"/mnt/disk1":{}}' ]] || devnet_die "Yugabyte volume contract mismatch"
  umask 077
  devnet_require_safe_write_path "${DEVNET_COMPOSE_ENV}" file
  local compose_environment_temporary="${DEVNET_COMPOSE_ENV}.temporary.$$"
  devnet_require_safe_write_path "${compose_environment_temporary}" file
  local proof_backend sector_size sector_size_bytes actor_network_bundle firehorse_height fil_proofs_use_zigzag fil_proofs_zigzag_generate_missing_params
  local parent_cache_dir parent_cache_window_nodes
  local curio_disable_actor_metadata_tasks
  if [[ -f "${DEVNET_PROOF_BACKEND_FILE}" && ! -L "${DEVNET_PROOF_BACKEND_FILE}" ]]; then
    proof_backend="$(devnet_current_proof_backend)"
  else
    proof_backend="$(devnet_requested_proof_backend)"
  fi
  if [[ -f "${DEVNET_SECTOR_SIZE_FILE}" && ! -L "${DEVNET_SECTOR_SIZE_FILE}" ]]; then
    sector_size="$(devnet_current_sector_size)"
  else
    sector_size="$(devnet_requested_sector_size)"
  fi
  sector_size_bytes="$(devnet_sector_size_bytes "${sector_size}")"
  actor_network_bundle="$(devnet_actor_network_bundle_for_sector_size "${sector_size}")"
  firehorse_height="$(devnet_firehorse_upgrade_epoch_for_sector_size "${sector_size}")"
  fil_proofs_use_zigzag="$(devnet_fil_proofs_use_zigzag "${proof_backend}")"
  fil_proofs_zigzag_generate_missing_params="$(devnet_fil_proofs_zigzag_generate_missing_params "${proof_backend}")"
  parent_cache_dir="$(devnet_parent_cache_dir_for_backend "${proof_backend}")"
  parent_cache_window_nodes="$(devnet_parent_cache_window_nodes)"
  curio_disable_actor_metadata_tasks="$(devnet_disable_actor_metadata_tasks_for_sector_size "${sector_size}")"
  devnet_require_safe_write_path "${parent_cache_dir}" directory
  mkdir -p "${parent_cache_dir}"

  (set -o noclobber; cat > "${compose_environment_temporary}" <<EOF
DEVNET_IMAGE_NAMESPACE=${DEVNET_IMAGE_NAMESPACE}
DEVNET_CURIO_SHORT_COMMIT=${curio_commit:0:12}
DEVNET_DATA_DIR=${DEVNET_DATA_DIR}
DEVNET_PROOF_BACKEND=${proof_backend}
DEVNET_SECTOR_SIZE=${sector_size}
LOTUS_DEVNET_NETWORK_BUNDLE=${actor_network_bundle}
DEVNET_PROOF_PARAMETERS_DIR=${DEVNET_PROOF_PARAMETERS_DIR}
DEVNET_PARENT_CACHE_DIR=${parent_cache_dir}
DEVNET_ZIGZAG_SIDECAR_DIR=${DEVNET_ZIGZAG_SIDECAR_DIR}
DEVNET_FIREHORSE_HEIGHT=${firehorse_height}
DEVNET_FILECOIN_SERVICES_SOURCE=${DEVNET_ROOT}/.cache/sources/filecoin_services/${services_commit}
DEVNET_MULTICALL3_SOURCE=${DEVNET_ROOT}/.cache/sources/multicall3/${multicall_commit}
DEVNET_YUGABYTE_IMAGE=yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8
SECTOR_SIZE=${sector_size_bytes}
FIL_PROOFS_USE_ZIGZAG=${fil_proofs_use_zigzag}
FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=${fil_proofs_zigzag_generate_missing_params}
FIL_PROOFS_ZIGZAG_SIDECAR_DIR=/var/tmp/filecoin-zigzag-proof-sidecars
FIL_PROOFS_PARENT_CACHE=/var/tmp/filecoin-parents
FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE=${fil_proofs_use_zigzag}
FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE=${parent_cache_window_nodes}
FIL_PROOFS_SDR_PARENTS_CACHE_SIZE=${parent_cache_window_nodes}
CURIO_DISABLE_ACTOR_METADATA_TASKS=${curio_disable_actor_metadata_tasks}
EOF
  ) || devnet_die "failed to create generated Compose environment"
  mv -- "${compose_environment_temporary}" "${DEVNET_COMPOSE_ENV}"
}

devnet_check_ports() {
  devnet_require_command lsof
  local port
  for port in 2234 22345 22300 22310 24701 22320 25433 29042 25434 23000 23001 23002 23003; do
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      devnet_die "required host port is already listening: ${port}"
    fi
  done
}

devnet_check_start_ports() {
  local existing_containers
  existing_containers="$(devnet_compose ps --all --quiet)" ||
    devnet_die "failed to inspect existing project containers"
  [[ -n "${existing_containers//[[:space:]]/}" ]] && return 0
  devnet_check_ports
}

devnet_inspect_rendered_compose() {
  node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 60000 -- \
    bash -c '
      set -o pipefail
      source "$1"
      devnet_compose config --format json |
        npm --prefix "$DEVNET_ROOT/tools" run cli -- devnet compose inspect "$DEVNET_COMPOSE_ENV"
    ' devnet-compose-inspect "${DEVNET_ROOT}/scripts/devnet-common.sh"
}

devnet_require_service() {
  local service="$1"
  for allowed in "${DEVNET_SERVICES[@]}"; do [[ "${service}" == "${allowed}" ]] && return 0; done
  devnet_die "unknown devnet service: ${service}"
}

devnet_require_owned_path() {
  local candidate="$1" expected="$2"
  [[ -n "${candidate}" && "${candidate}" != / && "${candidate}" != "${HOME:-}" ]] ||
    devnet_die "unsafe runtime path"
  [[ "${candidate}" == "${expected}" ]] || devnet_die "runtime path is outside this project"
  devnet_require_safe_write_path "${candidate}" directory
}

devnet_require_safe_write_path() {
  local candidate="$1" expected_kind="$2"
  [[ "${candidate}" == "${DEVNET_ROOT}" || "${candidate}" == "${DEVNET_ROOT}/"* ]] ||
    devnet_die "runtime path is outside this project"
  [[ ! -L "${DEVNET_ROOT}" ]] || devnet_die "repository root must not be symbolic"
  [[ -d "${DEVNET_ROOT}" ]] || devnet_die "repository root is not a directory"
  [[ "$(cd -P "${DEVNET_ROOT}" && pwd -P)" == "${DEVNET_ROOT}" ]] ||
    devnet_die "repository root must be a real path"

  local current="${DEVNET_ROOT}" relative component
  relative="${candidate#"${DEVNET_ROOT}"}"
  relative="${relative#/}"
  if [[ -n "${relative}" ]]; then
    while IFS= read -r component; do
      [[ -n "${component}" && "${component}" != . && "${component}" != .. ]] ||
        devnet_die "runtime path component is invalid"
      current="${current}/${component}"
      if [[ -e "${current}" || -L "${current}" ]]; then
        [[ ! -L "${current}" ]] || devnet_die "runtime path must not be symbolic: ${current}"
        if [[ "${current}" != "${candidate}" ]]; then
          [[ -d "${current}" ]] || devnet_die "runtime path ancestor is not a directory: ${current}"
          [[ "$(cd -P "${current}" && pwd -P)" == "${current}" ]] ||
            devnet_die "runtime path ancestor must be a real path: ${current}"
        fi
      fi
    done < <(printf '%s\n' "${relative//\//$'\n'}")
  fi

  if [[ -e "${candidate}" || -L "${candidate}" ]]; then
    [[ ! -L "${candidate}" ]] || devnet_die "runtime path must not be symbolic: ${candidate}"
    case "${expected_kind}" in
      directory)
        [[ -d "${candidate}" ]] || devnet_die "runtime path is not a directory: ${candidate}"
        [[ "$(cd -P "${candidate}" && pwd -P)" == "${candidate}" ]] ||
          devnet_die "runtime directory must be a real path: ${candidate}"
        ;;
      file)
        [[ -f "${candidate}" ]] || devnet_die "runtime path is not a regular file: ${candidate}"
        [[ "$(cd -P "$(dirname "${candidate}")" && pwd -P)/$(basename "${candidate}")" == "${candidate}" ]] ||
          devnet_die "runtime file must have a real path: ${candidate}"
        ;;
      *)
        devnet_die "invalid runtime path kind"
        ;;
    esac
  fi
}

devnet_validate_write_targets() {
  local path directory
  for path in \
    "${DEVNET_ROOT}" \
    "${DEVNET_ROOT}/.runtime" \
    "${DEVNET_RUNTIME_DIR}" \
    "${DEVNET_DATA_DIR}" \
    "${DEVNET_LOG_DIR}" \
    "${DEVNET_ROOT}/.runtime/deployments" \
    "${DEVNET_RUNTIME_DIR}/status" \
    "${DEVNET_ROOT}/.runtime/verification-backups" \
    "${DEVNET_ROOT}/.cache" \
    "${DEVNET_PROOF_PARAMETERS_DIR}" \
    "${DEVNET_ROOT}/.cache/stacked-parent-cache" \
    "${DEVNET_ROOT}/.cache/zigzag-parent-cache" \
    "${DEVNET_ZIGZAG_SIDECAR_DIR}"; do
    devnet_require_safe_write_path "${path}" directory
  done
  for directory in "${DEVNET_DATA_DIRECTORIES[@]}"; do
    devnet_require_safe_write_path "${DEVNET_DATA_DIR}/${directory}" directory
  done
  for path in \
    "${DEVNET_COMPOSE_ENV}" \
    "${DEVNET_PROOF_BACKEND_FILE}" \
    "${DEVNET_SECTOR_SIZE_FILE}" \
    "${DEVNET_RUNTIME_DIR}/ownership.marker" \
    "${DEVNET_RUNTIME_DIR}/generation" \
    "${DEVNET_DATA_DIR}/piece-server/.synapse-sdk.ready"; do
    devnet_require_safe_write_path "${path}" file
  done
}

devnet_require_runtime_tree() {
  devnet_validate_write_targets
}

devnet_require_ownership_marker() {
  local marker="${DEVNET_RUNTIME_DIR}/ownership.marker"
  [[ -f "${marker}" && ! -L "${marker}" ]] || devnet_die "missing project ownership marker"
  local expected actual
  expected="$(printf 'repository=%s\nproject=%s\n\034' "${DEVNET_ROOT}" "${DEVNET_PROJECT}")"
  actual="$({ cat "${marker}"; printf '\034'; })"
  [[ "${actual}" == "${expected}" ]] || devnet_die "ownership marker mismatch"
}

devnet_prepare_runtime() {
  devnet_validate_write_targets
  mkdir -p "${DEVNET_DATA_DIR}" "${DEVNET_LOG_DIR}" "${DEVNET_PROOF_PARAMETERS_DIR}" "${DEVNET_ROOT}/.cache/stacked-parent-cache" "${DEVNET_ROOT}/.cache/zigzag-parent-cache" "${DEVNET_ZIGZAG_SIDECAR_DIR}"
  for directory in "${DEVNET_DATA_DIRECTORIES[@]}"; do mkdir -p "${DEVNET_DATA_DIR}/${directory}"; done
  devnet_validate_write_targets
  local synapse_marker="${DEVNET_DATA_DIR}/piece-server/.synapse-sdk.ready"
  if [[ -e "${synapse_marker}" ]]; then
    [[ ! -s "${synapse_marker}" ]] || devnet_die "Synapse marker content mismatch"
  else
    (set -o noclobber; : > "${synapse_marker}") ||
      devnet_die "failed to create Synapse marker"
  fi
  local ownership_marker="${DEVNET_RUNTIME_DIR}/ownership.marker"
  if [[ -e "${ownership_marker}" ]]; then
    devnet_require_ownership_marker
  else
    (set -o noclobber; printf 'repository=%s\nproject=%s\n' "${DEVNET_ROOT}" "${DEVNET_PROJECT}" > "${ownership_marker}") ||
      devnet_die "failed to create ownership marker"
  fi
  local generation_file="${DEVNET_RUNTIME_DIR}/generation"
  if [[ ! -e "${generation_file}" ]]; then
    (set -o noclobber; printf 'generation-%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" > "${generation_file}") ||
      devnet_die "failed to create runtime generation"
  fi
}

devnet_die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

devnet_require_command() {
  command -v "$1" >/dev/null 2>&1 || devnet_die "required command not found: $1"
}

devnet_verify_deployment_code() {
  local manifest="$1"
  local curio_commit image
  curio_commit="$(jq -r '.curioCommit' "${DEVNET_BUILD_DIR}/images.json")"
  image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"
  node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 120000 -- \
    docker run --rm --network "${DEVNET_PROJECT}_default" \
    --entrypoint bash \
    -v "${manifest}:/manifest.json:ro" \
    "${image}" -ec '
      rpc=http://lotus:1234/rpc/v1
      while IFS=$'\''\t'\'' read -r name address expected kind implementation implementation_hash; do
        code="$(cast code --rpc-url "$rpc" "$address")"
        [[ "$code" =~ ^0x[0-9a-fA-F]+$ && "$code" != "0x" ]] || {
          printf "missing code for %s\n" "$name" >&2
          exit 1
        }
        actual="$(cast keccak "$code")"
        [[ "$actual" == "$expected" ]] || {
          printf "code hash mismatch for %s\n" "$name" >&2
          exit 1
        }
        if [[ "$kind" != "direct" ]]; then
          implementation_code="$(cast code --rpc-url "$rpc" "$implementation")"
          [[ "$implementation_code" != "0x" ]] || {
            printf "missing implementation code for %s\n" "$name" >&2
            exit 1
          }
          [[ "$(cast keccak "$implementation_code")" == "$implementation_hash" ]] || {
            printf "implementation code hash mismatch for %s\n" "$name" >&2
            exit 1
          }
          if [[ "$kind" == "uups" ]]; then
            slot=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
            live="$(cast storage --rpc-url "$rpc" "$address" "$slot")"
            live="0x${live: -40}"
          else
            live="$(cast call --rpc-url "$rpc" "$address" "implementation()(address)")"
          fi
          [[ "${live,,}" == "${implementation,,}" ]] || {
            printf "implementation pointer mismatch for %s\n" "$name" >&2
            exit 1
          }
        fi
      done < <(jq -r "
        .contracts | to_entries[] |
        [
          .key,
          .value.address,
          (.value.runtimeCodeHash // .value.codeHash),
          (.value.kind // \"direct\"),
          (.value.implementation // \"\"),
          (.value.implementationCodeHash // \"\")
        ] | @tsv
      " /manifest.json)
    '
}

devnet_sanitize_build_log() {
  local line
  local root_prefix="${DEVNET_ROOT%/}/"
  local home_prefix=""
  if [[ -n "${HOME:-}" ]]; then
    home_prefix="${HOME%/}/"
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    case "${line}" in
      "active containers before build:" | name=*project=*status=*image=*)
        continue
        ;;
    esac
    line="${line//"${root_prefix}"/}"
    if [[ -n "${home_prefix}" ]]; then
      line="${line//"${home_prefix}"/"[home]/"}"
    fi
    printf '%s\n' "${line}"
  done
}

devnet_archive_active_manifest() {
  local manifest_path="$1"
  local history_directory="$2"
  local archive_name="$3"
  local archive_path="${history_directory}/${archive_name}"

  if [[ ! -e "${manifest_path}" && ! -L "${manifest_path}" ]]; then
    return 0
  fi
  [[ -f "${manifest_path}" && ! -L "${manifest_path}" ]] ||
    devnet_die "active image manifest is not a regular file"
  [[ "${archive_name}" =~ ^images\.before-[0-9A-Za-z._-]+\.json$ ]] ||
    devnet_die "image manifest archive name is invalid"
  mkdir -p "${history_directory}"
  [[ -d "${history_directory}" && ! -L "${history_directory}" ]] ||
    devnet_die "image manifest history path is not a directory"
  [[ ! -e "${archive_path}" && ! -L "${archive_path}" ]] ||
    devnet_die "image manifest archive already exists"

  mv -- "${manifest_path}" "${archive_path}"
  printf '%s\n' "${archive_path}"
}

devnet_publish_manifest() {
  local temporary_manifest="$1"
  local active_manifest="$2"

  [[ -f "${temporary_manifest}" && ! -L "${temporary_manifest}" ]] ||
    devnet_die "temporary image manifest is not a regular file"
  [[ ! -e "${active_manifest}" && ! -L "${active_manifest}" ]] ||
    devnet_die "active image manifest must be absent before publication"
  chmod 0644 "${temporary_manifest}"
  mv -- "${temporary_manifest}" "${active_manifest}"
}

devnet_normalize_architecture() {
  case "$1" in
    arm64 | aarch64)
      printf '%s\n' arm64
      ;;
    amd64 | x86_64)
      printf '%s\n' amd64
      ;;
    *)
      devnet_die "unsupported architecture: $1"
      ;;
  esac
}

devnet_curio_source_path() {
  local CURIO_COMMIT="$1"
  printf '%s\n' "${DEVNET_ROOT}/.cache/sources/curio/${CURIO_COMMIT}"
}

devnet_lotus_source_path() {
  local LOTUS_COMMIT="$1"
  printf '%s\n' "${DEVNET_ROOT}/.cache/sources/lotus/${LOTUS_COMMIT}"
}

devnet_blst_source_path() {
  local BLST_COMMIT="$1"
  printf '%s\n' "${DEVNET_ROOT}/.cache/sources/blst/${BLST_COMMIT}"
}

devnet_rust_fil_proofs_source_path() {
  local commit="${1:-}"
  local configured="${DEVNET_RUST_FIL_PROOFS_SOURCE:-}"
  local resolved
  if [[ -z "${configured}" ]]; then
    if [[ -z "${commit}" ]]; then
      commit="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- lock verify |
        awk -F '\t' '$1 == "rust_fil_proofs" {print $3}')"
    fi
    [[ "${commit}" =~ ^[0-9a-f]{40}$ ]] ||
      devnet_die "ZigZag rust-fil-proofs lock entry is missing"
    configured="${DEVNET_ROOT}/.cache/sources/rust_fil_proofs/${commit}"
  fi
  if ! resolved="$(cd "${configured}" 2>/dev/null && pwd -P)"; then
    devnet_die "ZigZag rust-fil-proofs source is missing: ${configured}"
  fi
  [[ -d "${resolved}" && ! -L "${resolved}" ]] ||
    devnet_die "ZigZag rust-fil-proofs source path is missing or symbolic"
  printf '%s\n' "${resolved}"
}

devnet_zigzag_source_override_required_paths() {
  cat <<'EOF'
source-overrides/curio/cmd/sptool/toolbox_deal_client.go
source-overrides/curio/lib/ffi/unseal_funcs.go
source-overrides/curio/market/mk20/ddo_v1.go
source-overrides/curio/scripts/makefiles/10-deps.mk
source-overrides/curio/tasks/piece/task_park_piece.go
source-overrides/curio/tasks/unseal/task_unseal_decode.go
source-overrides/curio/tasks/unseal/task_unseal_sdr.go
source-overrides/filecoin-ffi/rust/Cargo.lock
source-overrides/filecoin-ffi/rust/Cargo.toml
source-overrides/filecoin-ffi/rust/src/bin/porep-proof-microbench.rs
source-overrides/filecoin-ffi/rust/src/proofs/api.rs
source-overrides/fvm-4.8.2-zigzag/Cargo.toml
source-overrides/fvm-4.8.2-zigzag/src/account_actor.rs
source-overrides/fvm-4.8.2-zigzag/src/kernel/filecoin.rs
source-overrides/lotus/build/buildconstants/devnet_network_bundle.go
source-overrides/lotus/entrypoint.sh
EOF
}

devnet_zigzag_source_overrides_sha256() {
  local overrides="${DEVNET_ROOT}/source-overrides"
  local path
  [[ -d "${overrides}" && ! -L "${overrides}" ]] ||
    devnet_die "ZigZag source overrides directory is missing"
  while IFS= read -r path; do
    [[ -f "${DEVNET_ROOT}/${path}" && ! -L "${DEVNET_ROOT}/${path}" ]] ||
      devnet_die "required ZigZag source override is missing or symbolic: ${path}"
  done < <(devnet_zigzag_source_override_required_paths)
  (
    cd "${DEVNET_ROOT}"
    find \
      source-overrides/curio \
      source-overrides/filecoin-ffi \
      source-overrides/fvm-4.8.2-zigzag \
      source-overrides/lotus \
      \( -type f -o -type l \) -print | LC_ALL=C sort | while read -r path; do
      [[ -f "${path}" && ! -L "${path}" ]] ||
        devnet_die "ZigZag source override is missing or symbolic: ${path}"
      printf '%s\n' "${path}"
      shasum -a 256 "${path}" | awk '{print $1}'
    done
  ) | shasum -a 256 | awk '{print $1}'
}

devnet_docker_surface_sha256() {
  local path
  {
    for path in \
      docker/curio-all-in-one.Dockerfile \
      docker/lotus/Dockerfile \
      docker/contracts-bootstrap/Dockerfile \
      docker/lotus-miner/Dockerfile \
      docker/curio/Dockerfile \
      docker/piece-server/Dockerfile \
      docker/indexer/Dockerfile; do
      [[ -f "${DEVNET_ROOT}/${path}" && ! -L "${DEVNET_ROOT}/${path}" ]] ||
        devnet_die "Docker build surface input is missing or symbolic: ${path}"
      printf '%s\n' "${path}"
      shasum -a 256 "${DEVNET_ROOT}/${path}" | awk '{print $1}'
    done
    printf 'source-overrides\n'
    devnet_zigzag_source_overrides_sha256
  } | shasum -a 256 | awk '{print $1}'
}

devnet_rust_fil_proofs_zigzag_api_sha256() {
  local source zigzag_api zigzag_caches
  source="$(devnet_rust_fil_proofs_source_path "${1:-}")"
  zigzag_api="${source}/filecoin-proofs/src/api/zigzag.rs"
  zigzag_caches="${source}/filecoin-proofs/src/caches.rs"
  [[ -f "${zigzag_api}" && ! -L "${zigzag_api}" ]] ||
    devnet_die "ZigZag rust-fil-proofs API file is missing"
  [[ -f "${zigzag_caches}" && ! -L "${zigzag_caches}" ]] ||
    devnet_die "ZigZag rust-fil-proofs cache file is missing"
  {
    printf 'filecoin-proofs/src/api/zigzag.rs\n'
    shasum -a 256 "${zigzag_api}" | awk '{print $1}'
    printf 'filecoin-proofs/src/caches.rs\n'
    shasum -a 256 "${zigzag_caches}" | awk '{print $1}'
  } | shasum -a 256 | awk '{print $1}'
}
