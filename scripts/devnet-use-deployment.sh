#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

deployment_id="${1:?deployment ID is required}"
requested_revision="${2:-latest}"
if [[ "${deployment_id}" == active ]]; then
  active_selector="${DEVNET_ROOT}/.runtime/deployments/active.json"
  [[ -f "${active_selector}" && ! -L "${active_selector}" ]] ||
    devnet_die "no active deployment is selected"
  deployment_id="$(jq -r '.deploymentId' "${active_selector}")"
  if [[ "${requested_revision}" == latest ]]; then
    requested_revision="$(jq -r '.revision' "${active_selector}")"
  fi
fi
[[ "${deployment_id}" =~ ^deployment-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  devnet_die "deployment ID is invalid"
deployment_dir="${DEVNET_ROOT}/.runtime/deployments/${deployment_id}"
[[ -d "${deployment_dir}/revisions" && ! -L "${deployment_dir}" ]] ||
  devnet_die "deployment is missing: ${deployment_id}"

if [[ "${requested_revision}" == latest ]]; then
  shopt -s nullglob
  revisions=("${deployment_dir}"/revisions/[0-9][0-9][0-9].json)
  ((${#revisions[@]} > 0)) || devnet_die "deployment has no completed revisions"
  manifest="${revisions[$((${#revisions[@]} - 1))]}"
else
  [[ "${requested_revision}" =~ ^[0-9]+$ ]] || devnet_die "revision must be a number or latest"
  printf -v revision_file '%03d.json' "${requested_revision}"
  manifest="${deployment_dir}/revisions/${revision_file}"
fi
[[ -f "${manifest}" && ! -L "${manifest}" ]] || devnet_die "deployment revision is missing"

bash "${DEVNET_ROOT}/scripts/devnet-status.sh" >/dev/null
status="${DEVNET_RUNTIME_DIR}/status/latest.json"
generation="$(jq -r '.generation' "${status}")"
chain_id="$(($(jq -r '.chain.chainId' "${status}")))"
provider="$(jq -r '.miner.provider' "${status}")"
proof_backend="$(jq -r '.proof.backend' "${status}")"
sector_size_selector="$(jq -r '.sector.selector' "${status}")"
genesis_cid="$(
  devnet_compose exec -T lotus lotus chain list --epoch 0 --count 1 --format '<tipset>' |
    tr -d '\r\n'
)"
npm --prefix "${DEVNET_ROOT}/tools" run cli -- deployment revision inspect \
  "${generation}" "${genesis_cid}" "${chain_id}" "${provider}" "${proof_backend}" "${sector_size_selector}" <"${manifest}"
devnet_verify_deployment_code "${manifest}"

revision="$(jq -r '.revision' "${manifest}")"
active="${DEVNET_ROOT}/.runtime/deployments/active.json"
temporary="${active}.temporary.$$"
jq -n --arg deploymentId "${deployment_id}" --argjson revision "${revision}" \
  '{schemaVersion:1,deploymentId:$deploymentId,revision:$revision}' >"${temporary}"
mv -- "${temporary}" "${active}"
printf 'active deployment: %s revision=%s\n' "${deployment_id}" "${revision}"
