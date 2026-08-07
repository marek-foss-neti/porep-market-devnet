#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"

devnet_require_command docker
backend="$(devnet_requested_proof_backend "${1:-}")"
devnet_require_runtime_tree
devnet_require_owned_path "${DEVNET_DATA_DIR}" "${DEVNET_RUNTIME_DIR}/data"
devnet_require_ownership_marker

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_root="${DEVNET_ROOT}/.runtime/reset-evidence/reset-${timestamp}"
devnet_require_safe_write_path "${DEVNET_ROOT}/.runtime/reset-evidence" directory
devnet_require_safe_write_path "${evidence_root}" directory
mkdir -p "${evidence_root}"

node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 30000 -- \
  bash -c 'source "$1"; devnet_compose logs --tail 300' \
  devnet-reset "${DEVNET_ROOT}/scripts/devnet-common.sh" \
  >"${evidence_root}/final-logs.txt" 2>&1 || true
for identity in \
  "${DEVNET_RUNTIME_DIR}/status/latest.json" \
  "${DEVNET_RUNTIME_DIR}/generation" \
  "${DEVNET_ROOT}/.runtime/deployments/active.json"; do
  if [[ -f "${identity}" && ! -L "${identity}" ]]; then
    cp -- "${identity}" "${evidence_root}/$(basename "${identity}")"
  fi
done

node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" \
  --timeout-ms "${DEVNET_LIFECYCLE_TIMEOUT_MS}" -- \
  bash -c 'source "$1"; devnet_compose down --volumes --remove-orphans' \
  devnet-reset "${DEVNET_ROOT}/scripts/devnet-common.sh"

for directory in \
  "${DEVNET_DATA_DIR}" \
  "${DEVNET_LOG_DIR}" \
  "${DEVNET_RUNTIME_DIR}/status" \
  "${DEVNET_ROOT}/.runtime/fixtures"; do
  if [[ -e "${directory}" ]]; then
    devnet_require_safe_write_path "${directory}" directory
    rm -r -- "${directory}"
  fi
done
rm -f -- \
  "${DEVNET_COMPOSE_ENV}" \
  "${DEVNET_PROOF_BACKEND_FILE}" \
  "${DEVNET_RUNTIME_DIR}/generation" \
  "${DEVNET_ROOT}/.runtime/deployments/active.json"

deployments_root="${DEVNET_ROOT}/.runtime/deployments"
if [[ -d "${deployments_root}" ]]; then
  find "${deployments_root}" -mindepth 2 -maxdepth 2 \
    -type f -name identities.private.json -delete
fi

mkdir -p "${DEVNET_DATA_DIR}"
devnet_prepare_runtime
devnet_write_proof_backend "${backend}"
