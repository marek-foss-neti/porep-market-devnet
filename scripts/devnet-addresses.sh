#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

bash "${DEVNET_ROOT}/scripts/devnet-status.sh" >/dev/null
deployment_arg="${1:-active}"
output="${2:-addresses}"
[[ "${output}" == addresses || "${output}" == tooling-env ]] ||
  devnet_die "deployment output format is invalid"
active="${DEVNET_ROOT}/.runtime/deployments/active.json"
if [[ "${deployment_arg}" == active ]]; then
  [[ -f "${active}" && ! -L "${active}" ]] || devnet_die "active deployment is missing; run just deploy"
  deployment_id="$(jq -r '.deploymentId' "${active}")"
  revision="$(jq -r '.revision' "${active}")"
else
  deployment_id="${deployment_arg}"
  revision=0
fi
[[ "${deployment_id}" =~ ^deployment-[A-Za-z0-9][A-Za-z0-9._-]*$ && "${revision}" =~ ^[0-9]+$ ]] ||
  devnet_die "deployment selection is invalid"
printf -v revision_file '%03d.json' "${revision}"
manifest="${DEVNET_ROOT}/.runtime/deployments/${deployment_id}/revisions/${revision_file}"
[[ -f "${manifest}" && ! -L "${manifest}" ]] || devnet_die "deployment revision is missing"
generation="$(jq -r '.generation' "${DEVNET_RUNTIME_DIR}/status/latest.json")"
chain_id="$(jq -r '.chain.chainId' "${DEVNET_RUNTIME_DIR}/status/latest.json")"
chain_id="$((chain_id))"
provider="$(jq -r '.miner.provider' "${DEVNET_RUNTIME_DIR}/status/latest.json")"
proof_backend="$(jq -r '.proof.backend' "${DEVNET_RUNTIME_DIR}/status/latest.json")"
genesis_cid="$(
  devnet_compose exec -T lotus lotus chain list --epoch 0 --count 1 --format '<tipset>' |
    tr -d '\r\n'
)"

npm --prefix "${DEVNET_ROOT}/tools" run --silent cli -- deployment revision inspect \
  "${generation}" "${genesis_cid}" "${chain_id}" "${provider}" "${proof_backend}" <"${manifest}" >/dev/null
devnet_verify_deployment_code "${manifest}"
npm --prefix "${DEVNET_ROOT}/tools" run --silent cli -- deployment revision "${output}" <"${manifest}"
