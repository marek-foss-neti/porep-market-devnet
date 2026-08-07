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
DEVNET_PROOF_PARAMETERS_DIR="${DEVNET_ROOT}/.cache/proof-parameters"
DEVNET_LIFECYCLE_TIMEOUT_MS=120000
DEVNET_SERVICES=(lotus contracts-bootstrap lotus-miner curio yugabyte piece-server indexer)
DEVNET_DATA_DIRECTORIES=(lotus lotus-miner curio piece-server indexer contracts genesis yugabyte yugabyte-disk0 yugabyte-disk1)

devnet_compose() {
  env -u DEVNET_IMAGE_NAMESPACE -u DEVNET_CURIO_SHORT_COMMIT -u DEVNET_DATA_DIR \
    -u DEVNET_PROOF_BACKEND -u DEVNET_PROOF_PARAMETERS_DIR \
    -u DEVNET_FILECOIN_SERVICES_SOURCE -u DEVNET_MULTICALL3_SOURCE \
    -u DEVNET_YUGABYTE_IMAGE -u FIL_PROOFS_USE_ZIGZAG \
    -u FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS \
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
    devnet_die "proof backend marker is missing; run just reset stacked or just reset zigzag"
  value="$(tr -d '\r\n[:space:]' < "${DEVNET_PROOF_BACKEND_FILE}")"
  devnet_normalize_proof_backend "${value}"
}

devnet_require_proof_backend() {
  local requested current existing_containers
  requested="$(devnet_requested_proof_backend "${1:-}")"
  if [[ -f "${DEVNET_PROOF_BACKEND_FILE}" && ! -L "${DEVNET_PROOF_BACKEND_FILE}" ]]; then
    current="$(devnet_current_proof_backend)"
    [[ "${current}" == "${requested}" ]] ||
      devnet_die "existing runtime uses proof backend ${current}; run just reset ${requested} to switch"
    return 0
  fi
  existing_containers="$(devnet_compose ps --all --quiet 2>/dev/null || true)"
  [[ -z "${existing_containers//[[:space:]]/}" ]] ||
    devnet_die "existing runtime has no proof backend marker; run just reset ${requested}"
  devnet_write_proof_backend "${requested}"
}

devnet_write_compose_env() {
  local source_output curio_commit lotus_commit blst_commit services_commit multicall_commit
  local manifest_zigzag_patch manifest_zigzag_api
  source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
  curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
  lotus_commit="$(awk -F '\t' '$1 == "lotus" {print $3}' <<<"${source_output}")"
  blst_commit="$(awk -F '\t' '$1 == "blst" {print $3}' <<<"${source_output}")"
  services_commit="$(awk -F '\t' '$1 == "filecoin_services" {print $3}' <<<"${source_output}")"
  multicall_commit="$(awk -F '\t' '$1 == "multicall3" {print $3}' <<<"${source_output}")"
  [[ "${curio_commit}" =~ ^[0-9a-f]{40}$ && "${lotus_commit}" =~ ^[0-9a-f]{40}$ && "${blst_commit}" =~ ^[0-9a-f]{40}$ && "${services_commit}" =~ ^[0-9a-f]{40}$ && "${multicall_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "verified managed source contract is incomplete"
  local image_manifest="${DEVNET_BUILD_DIR}/images.json"
  [[ -f "${image_manifest}" && ! -L "${image_manifest}" ]] || devnet_die "verified image manifest is missing"
  [[ "$(jq -r '.schemaVersion' "${image_manifest}")" == 1 && "$(jq -r '.namespace' "${image_manifest}")" == "${DEVNET_IMAGE_NAMESPACE}" && "$(jq -r '.tag' "${image_manifest}")" == "${curio_commit:0:12}" ]] || devnet_die "image manifest identity is invalid"
  manifest_lotus="$(jq -r '.lotusCommit' "${image_manifest}")"
  manifest_blst="$(jq -r '.blstCommit' "${image_manifest}")"
  manifest_hash="$(jq -r '.dockerfileSha256' "${image_manifest}")"
  manifest_zigzag_patch="$(jq -r '.zigzagFilecoinFfiPatchSha256 // empty' "${image_manifest}")"
  manifest_zigzag_api="$(jq -r '.zigzagRustFilProofsApiSha256 // empty' "${image_manifest}")"
  manifest_platform="$(jq -r '.platform' "${image_manifest}")"
  [[ "${manifest_lotus}" =~ ^[0-9a-f]{40}$ && "${manifest_blst}" =~ ^[0-9a-f]{40}$ && "${manifest_hash}" =~ ^[0-9a-f]{64}$ && "${manifest_zigzag_patch}" =~ ^[0-9a-f]{64}$ && "${manifest_zigzag_api}" =~ ^[0-9a-f]{64}$ && "${manifest_platform}" =~ ^linux/(amd64|arm64)$ ]] || devnet_die "image manifest fields are invalid"
  [[ "${manifest_lotus}" == "${lotus_commit}" && "${manifest_blst}" == "${blst_commit}" ]] || devnet_die "image manifest source commits do not match verified sources"
  [[ "$(devnet_docker_surface_sha256)" == "${manifest_hash}" ]] || devnet_die "image manifest Dockerfile hash mismatch"
  [[ "$(devnet_filecoin_ffi_zigzag_patch_sha256)" == "${manifest_zigzag_patch}" ]] || devnet_die "image manifest ZigZag filecoin-ffi patch hash mismatch"
  [[ "$(devnet_rust_fil_proofs_zigzag_api_sha256)" == "${manifest_zigzag_api}" ]] || devnet_die "image manifest ZigZag rust-fil-proofs API hash mismatch"
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
    actual_zigzag_patch="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.zigzag.filecoin-ffi.patch.sha256"}}')"
    actual_zigzag_api="$(docker image inspect "${DEVNET_IMAGE_NAMESPACE}/${image}:${curio_commit:0:12}" --format '{{index .Config.Labels "io.porep-market.zigzag.rust-fil-proofs.api.sha256"}}')"
    [[ "${actual_lotus}" == "${manifest_lotus}" && "${actual_blst}" == "${manifest_blst}" && "${actual_dockerfile}" == "${manifest_hash}" && "${actual_zigzag_patch}" == "${manifest_zigzag_patch}" && "${actual_zigzag_api}" == "${manifest_zigzag_api}" ]] || devnet_die "image identity labels mismatch: ${image}"
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
  local proof_backend fil_proofs_use_zigzag fil_proofs_zigzag_generate_missing_params
  if [[ -f "${DEVNET_PROOF_BACKEND_FILE}" && ! -L "${DEVNET_PROOF_BACKEND_FILE}" ]]; then
    proof_backend="$(devnet_current_proof_backend)"
  else
    proof_backend="$(devnet_requested_proof_backend)"
  fi
  fil_proofs_use_zigzag="$(devnet_fil_proofs_use_zigzag "${proof_backend}")"
  fil_proofs_zigzag_generate_missing_params="$(devnet_fil_proofs_zigzag_generate_missing_params "${proof_backend}")"

  (set -o noclobber; cat > "${compose_environment_temporary}" <<EOF
DEVNET_IMAGE_NAMESPACE=${DEVNET_IMAGE_NAMESPACE}
DEVNET_CURIO_SHORT_COMMIT=${curio_commit:0:12}
DEVNET_DATA_DIR=${DEVNET_DATA_DIR}
DEVNET_PROOF_BACKEND=${proof_backend}
DEVNET_PROOF_PARAMETERS_DIR=${DEVNET_PROOF_PARAMETERS_DIR}
DEVNET_FILECOIN_SERVICES_SOURCE=${DEVNET_ROOT}/.cache/sources/filecoin_services/${services_commit}
DEVNET_MULTICALL3_SOURCE=${DEVNET_ROOT}/.cache/sources/multicall3/${multicall_commit}
DEVNET_YUGABYTE_IMAGE=yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8
FIL_PROOFS_USE_ZIGZAG=${fil_proofs_use_zigzag}
FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS=${fil_proofs_zigzag_generate_missing_params}
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
    "${DEVNET_PROOF_PARAMETERS_DIR}"; do
    devnet_require_safe_write_path "${path}" directory
  done
  for directory in "${DEVNET_DATA_DIRECTORIES[@]}"; do
    devnet_require_safe_write_path "${DEVNET_DATA_DIR}/${directory}" directory
  done
  for path in \
    "${DEVNET_COMPOSE_ENV}" \
    "${DEVNET_PROOF_BACKEND_FILE}" \
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
  mkdir -p "${DEVNET_DATA_DIR}" "${DEVNET_LOG_DIR}" "${DEVNET_PROOF_PARAMETERS_DIR}"
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
  local configured="${DEVNET_RUST_FIL_PROOFS_SOURCE:-${DEVNET_ROOT}/../rust-fil-proofs}"
  local resolved
  if ! resolved="$(cd "${configured}" 2>/dev/null && pwd -P)"; then
    devnet_die "ZigZag rust-fil-proofs source is missing: ${configured}"
  fi
  [[ -d "${resolved}" && ! -L "${resolved}" ]] ||
    devnet_die "ZigZag rust-fil-proofs source path is missing or symbolic"
  printf '%s\n' "${resolved}"
}

devnet_filecoin_ffi_zigzag_patch_sha256() {
  local patch="${DEVNET_ROOT}/patches/filecoin-ffi/0001-zigzag-devnet-ffi.patch"
  [[ -f "${patch}" && ! -L "${patch}" ]] ||
    devnet_die "ZigZag filecoin-ffi patch is missing"
  shasum -a 256 "${patch}" | awk '{print $1}'
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
      docker/indexer/Dockerfile \
      patches/curio/0002-lotus-entrypoint-zigzag-runtime-only.patch \
      patches/curio/0003-zigzag-devnet-unseal.patch \
      patches/filecoin-ffi/0002-zigzag-devnet-fvm4-path.patch \
      patches/fvm/0001-zigzag-devnet-verifier.patch; do
      [[ -f "${DEVNET_ROOT}/${path}" && ! -L "${DEVNET_ROOT}/${path}" ]] ||
        devnet_die "Docker build surface input is missing or symbolic: ${path}"
      printf '%s\n' "${path}"
      shasum -a 256 "${DEVNET_ROOT}/${path}" | awk '{print $1}'
    done
  } | shasum -a 256 | awk '{print $1}'
}

devnet_rust_fil_proofs_zigzag_api_sha256() {
  local source zigzag_api zigzag_caches
  source="$(devnet_rust_fil_proofs_source_path)"
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
