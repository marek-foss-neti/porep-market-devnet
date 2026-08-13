#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command git
devnet_require_command jq
devnet_require_command node
bash "${DEVNET_ROOT}/scripts/devnet-status.sh" >/dev/null

source_arg="${1:-}"
source_arg="${source_arg#source=}"
status="${DEVNET_RUNTIME_DIR}/status/latest.json"
generation="$(jq -r '.generation' "${status}")"
chain_hex="$(jq -r '.chain.chainId' "${status}")"
chain_id="$((chain_hex))"
epoch="$(jq -r '.chain.epoch' "${status}")"
provider="$(jq -r '.miner.provider' "${status}")"
proof_backend="$(jq -r '.proof.backend' "${status}")"
sector_size_selector="$(jq -r '.sector.selector' "${status}")"
sector_size_bytes="$(jq -r '.sector.bytes' "${status}")"
genesis_cid="$(
  devnet_compose exec -T lotus lotus chain list --epoch 0 --count 1 --format '<tipset>' |
    tr -d '\r\n'
)"

ensure_meta_allocator_notary() {
  local deployment_manifest="$1"
  local allowance=999999999999999999
  local meta_allocator meta_filecoin current before_tx_id new_tx_id
  meta_allocator="$(jq -r '.contracts.MetaAllocator.address' "${deployment_manifest}")"
  meta_filecoin="$(
    devnet_compose exec -T lotus lotus evm stat "${meta_allocator}" |
      awk '/Filecoin address:/{print $3}' |
      tr -d '\r\n'
  )"
  [[ "${meta_filecoin}" == t4* ]] || devnet_die "could not resolve MetaAllocator Filecoin address"

  current="$(devnet_compose exec -T lotus lotus filplus check-notary-datacap "${meta_filecoin}" 2>/dev/null || true)"
  if [[ -n "${current}" && "${current}" != *"not found"* ]]; then
    return 0
  fi

  before_tx_id="$(
    devnet_compose exec -T lotus lotus msig inspect f080 |
      awk '/^Transactions:/{flag=1; next} flag && /^[0-9]+/{print $1}' |
      sort -nr |
      head -n1
  )"
  devnet_compose exec -T lotus lotus-shed verifreg add-verifier \
    t0100 "${meta_filecoin}" "${allowance}" >>"${deployment_dir}/deploy.log"

  for _ in {1..30}; do
    new_tx_id="$(
      devnet_compose exec -T lotus lotus msig inspect f080 |
        awk '/^Transactions:/{flag=1; next} flag && /^[0-9]+/{print $1}' |
        sort -nr |
        head -n1
    )"
    [[ -n "${new_tx_id}" && "${new_tx_id}" != "${before_tx_id}" ]] && break
    sleep 2
  done
  [[ -n "${new_tx_id}" && "${new_tx_id}" != "${before_tx_id}" ]] ||
    devnet_die "MetaAllocator verifier proposal was not created"

  devnet_compose exec -T lotus lotus msig approve --from t0101 f080 "${new_tx_id}" \
    >>"${deployment_dir}/deploy.log"
  for _ in {1..60}; do
    current="$(devnet_compose exec -T lotus lotus filplus check-notary-datacap "${meta_filecoin}" 2>/dev/null || true)"
    if [[ -n "${current}" && "${current}" != *"not found"* ]]; then
      printf 'MetaAllocator DataCap authority: %s\n' "${current}"
      return 0
    fi
    sleep 2
  done
  devnet_die "MetaAllocator DataCap authority did not become active"
}

latest_root_msig_transaction_id() {
  devnet_compose exec -T lotus lotus msig inspect f080 |
    awk '/^Transactions:/{flag=1; next} flag && /^[0-9]+/{print $1}' |
    sort -nr |
    head -n1
}

wait_for_actor_address() {
  local address="$1"
  local label="$2"
  for _ in {1..60}; do
    if devnet_compose exec -T lotus lotus state get-actor "${address}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  devnet_die "${label} actor did not become active: ${address}"
}

ensure_mk12_client_datacap() {
  local notary_allowance=1000000000000
  local client_allowance=1000000000
  local client current notary notary_file before_tx_id new_tx_id
  client="$(
    devnet_compose exec -T piece-server \
      sptool --actor t01000 toolbox mk12-client wallet default |
      tr -d '\r\n'
  )"
  [[ "${client}" == t* ]] || devnet_die "could not resolve mk12 client wallet"

  current="$(devnet_compose exec -T lotus lotus filplus check-client-datacap "${client}" 2>/dev/null || true)"
  if [[ -n "${current}" && "${current}" != *"not a verified client"* ]]; then
    printf 'mk12 client DataCap: %s\n' "${current}"
    return 0
  fi

  notary_file="${DEVNET_DATA_DIR}/contracts/mk12-client-notary.addr"
  if [[ -f "${notary_file}" && ! -L "${notary_file}" ]]; then
    notary="$(tr -d '\r\n' < "${notary_file}")"
  else
    devnet_require_safe_write_path "${notary_file}" file
    notary="$(devnet_compose exec -T lotus lotus wallet new secp256k1 | tr -d '\r\n')"
    printf '%s\n' "${notary}" > "${notary_file}"
  fi
  [[ "${notary}" == t* ]] || devnet_die "could not create mk12 client notary wallet"

  if ! devnet_compose exec -T lotus lotus state get-actor "${notary}" >/dev/null 2>&1; then
    devnet_compose exec -T lotus lotus send "${notary}" 10 >>"${deployment_dir}/deploy.log"
    wait_for_actor_address "${notary}" "mk12 client notary"
  fi

  current="$(devnet_compose exec -T lotus lotus filplus check-notary-datacap "${notary}" 2>/dev/null || true)"
  if [[ -z "${current}" || "${current}" == *"not found"* ]]; then
    before_tx_id="$(latest_root_msig_transaction_id)"
    devnet_compose exec -T lotus lotus-shed verifreg add-verifier \
      t0100 "${notary}" "${notary_allowance}" >>"${deployment_dir}/deploy.log"

    for _ in {1..30}; do
      new_tx_id="$(latest_root_msig_transaction_id)"
      [[ -n "${new_tx_id}" && "${new_tx_id}" != "${before_tx_id}" ]] && break
      sleep 2
    done
    [[ -n "${new_tx_id}" && "${new_tx_id}" != "${before_tx_id}" ]] ||
      devnet_die "mk12 client notary verifier proposal was not created"

    devnet_compose exec -T lotus lotus msig approve --from t0101 f080 "${new_tx_id}" \
      >>"${deployment_dir}/deploy.log"
    for _ in {1..60}; do
      current="$(devnet_compose exec -T lotus lotus filplus check-notary-datacap "${notary}" 2>/dev/null || true)"
      if [[ -n "${current}" && "${current}" != *"not found"* ]]; then
        break
      fi
      sleep 2
    done
    [[ -n "${current}" && "${current}" != *"not found"* ]] ||
      devnet_die "mk12 client notary DataCap authority did not become active"
  fi

  devnet_compose exec -T lotus lotus filplus grant-datacap \
    --from "${notary}" "${client}" "${client_allowance}" >>"${deployment_dir}/deploy.log"
  for _ in {1..60}; do
    current="$(devnet_compose exec -T lotus lotus filplus check-client-datacap "${client}" 2>/dev/null || true)"
    if [[ -n "${current}" && "${current}" != *"not a verified client"* ]]; then
      printf 'mk12 client DataCap: %s\n' "${current}"
      return 0
    fi
    sleep 2
  done
  devnet_die "mk12 client DataCap did not become active"
}

normalized_runtime_hash() {
  local artifact_path="$1" runtime="${2:-}" normalized
  if [[ -n "${runtime}" ]]; then
    normalized="$(node "${DEVNET_ROOT}/scripts/normalize-runtime-bytecode.mjs" \
      "${artifact_path}" "${runtime}")"
  else
    normalized="$(node "${DEVNET_ROOT}/scripts/normalize-runtime-bytecode.mjs" \
      "${artifact_path}")"
  fi
  devnet_compose exec -T curio cast keccak "${normalized}" | awk '{print $1}'
}

verify_target_runtime_bytecode() {
  local deployment_manifest="$1" target_root="$2"
  local contract_name kind implementation artifact artifact_path runtime live_hash target_hash
  local live_hash_lower target_hash_lower
  while IFS=$'\t' read -r contract_name kind implementation; do
    artifact="${contract_name}"
    [[ "${kind}" == beacon ]] && artifact=Validator
    artifact_path="${target_root}/out/${artifact}.sol/${artifact}.json"
    [[ -f "${artifact_path}" && ! -L "${artifact_path}" ]] ||
      devnet_die "compiled target artifact is missing: ${artifact}"
    runtime="$(devnet_compose exec -T curio cast code "${implementation}" \
      --rpc-url http://lotus:1234/rpc/v1 | awk '{print $1}')"
    live_hash="$(normalized_runtime_hash "${artifact_path}" "${runtime}")"
    target_hash="$(normalized_runtime_hash "${artifact_path}")"
    live_hash_lower="$(printf '%s' "${live_hash}" | tr '[:upper:]' '[:lower:]')"
    target_hash_lower="$(printf '%s' "${target_hash}" | tr '[:upper:]' '[:lower:]')"
    [[ "${live_hash_lower}" == "${target_hash_lower}" ]] ||
      devnet_die "runtime bytecode mismatch for ${contract_name}"
  done < <(jq -r '
    .contracts | to_entries[]
    | select(.value.kind == "uups" or (.key == "ValidatorBeacon" and .value.kind == "beacon"))
    | [.key, .value.kind, .value.implementation] | @tsv
  ' "${deployment_manifest}")
}

key_file="${DEVNET_DATA_DIR}/contracts/deployer.private-key"
[[ -f "${key_file}" && ! -L "${key_file}" ]] || devnet_die "DevNet deployer key is unavailable"

source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
if [[ -n "${source_arg}" ]]; then
  [[ "${source_arg}" == /* ]] || devnet_die "PoRep Market source must be an absolute path"
  porep_commit="$(git -C "${source_arg}" rev-parse HEAD)"
else
  porep_commit="$(awk -F '\t' '$1 == "porep_market" {print $3}' <<<"${source_output}")"
fi
filecoin_pay_commit="$(awk -F '\t' '$1 == "filecoin_pay" {print $3}' <<<"${source_output}")"
meta_commit="$(awk -F '\t' '$1 == "contract_metaallocator" {print $3}' <<<"${source_output}")"
[[ "${porep_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "PoRep Market source HEAD is invalid"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
deployment_id="deployment-${timestamp}-${porep_commit:0:12}"
deployments_root="${DEVNET_ROOT}/.runtime/deployments"
deployment_dir="${deployments_root}/${deployment_id}"
[[ ! -e "${deployment_dir}" && ! -L "${deployment_dir}" ]] ||
  devnet_die "deployment ID already exists; wait one second and retry"
mkdir -p "${deployment_dir}/work" "${deployment_dir}/revisions"
target_args=(contract-target prepare "${deployment_id}")
if [[ -n "${source_arg}" ]]; then
  target_args+=(--source "${source_arg}")
fi
target_json="${deployment_dir}/target.json"
npm --silent --prefix "${DEVNET_ROOT}/tools" run cli -- "${target_args[@]}" >"${target_json}"
porep_snapshot="$(jq -r '.snapshotPath' "${target_json}")"
[[ -d "${porep_snapshot}" && ! -L "${porep_snapshot}" ]] ||
  devnet_die "prepared PoRep Market snapshot is unavailable"

for pair in \
  "filecoin-pay:${DEVNET_ROOT}/.cache/sources/filecoin_pay/${filecoin_pay_commit}" \
  "metaallocator:${DEVNET_ROOT}/.cache/sources/contract_metaallocator/${meta_commit}"; do
  name="${pair%%:*}"
  source_path="${pair#*:}"
  destination="${deployment_dir}/work/${name}"
  cp -R "${source_path}" "${destination}"
done

printf '%s\n' "${source_output}" | jq -Rn '
  [inputs | split("\t") | select(length >= 3 and .[0] != "") | {key: .[0], value: .[2]}]
  | from_entries
' > "${deployment_dir}/sources.json"

manifest="${deployment_dir}/revisions/000.json"
temporary="${manifest}.temporary.$$"
image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"
node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 1800000 -- \
  docker run --rm --network "${DEVNET_PROJECT}_default" \
  --entrypoint bash \
  -e RPC_URL=http://lotus:1234/rpc/v1 \
  -e "GENERATION=${generation}" \
  -e "GENESIS_CID=${genesis_cid}" \
  -e "CHAIN_ID=${chain_id}" \
  -e "EPOCH=${epoch}" \
  -e "PROVIDER=${provider}" \
  -e "PROOF_BACKEND=${proof_backend}" \
  -e "SECTOR_SIZE_SELECTOR=${sector_size_selector}" \
  -e "SECTOR_SIZE_BYTES=${sector_size_bytes}" \
  -e "DEPLOYMENT_ID=${deployment_id}" \
  -e "DEPLOYMENT_ROOT=/workspace/.runtime/deployments/${deployment_id}" \
  -e "POREP_TARGET_ROOT=/workspace/${porep_snapshot#"${DEVNET_ROOT}/"}" \
  -e "TARGET_JSON=/workspace/.runtime/deployments/${deployment_id}/target.json" \
  -e "OUTPUT_MANIFEST=/workspace/.runtime/deployments/${deployment_id}/revisions/$(basename "${temporary}")" \
  -v "${DEVNET_ROOT}:/workspace:rw" \
  -v "${key_file}:/run/secrets/deployer-key:ro" \
  -v "${DEVNET_ROOT}/.cache/sources/filecoin_pay/${filecoin_pay_commit}:/workspace/.cache/sources/filecoin_pay/${filecoin_pay_commit}:ro" \
  -v "${DEVNET_ROOT}/.cache/sources/contract_metaallocator/${meta_commit}:/workspace/.cache/sources/contract_metaallocator/${meta_commit}:ro" \
  "${image}" /workspace/scripts/contracts-deploy-in-container.sh

npm --prefix "${DEVNET_ROOT}/tools" run cli -- deployment revision inspect \
  "${generation}" "${genesis_cid}" "${chain_id}" "${provider}" "${proof_backend}" "${sector_size_selector}" <"${temporary}"
devnet_verify_deployment_code "${temporary}"
verify_target_runtime_bytecode "${temporary}" "${porep_snapshot}"
ensure_meta_allocator_notary "${temporary}"
ensure_mk12_client_datacap
mv -- "${temporary}" "${manifest}"

active="${deployments_root}/active.json"
active_temporary="${active}.temporary.$$"
jq -n --arg deploymentId "${deployment_id}" \
  '{schemaVersion:1,deploymentId:$deploymentId,revision:0}' >"${active_temporary}"
mv -- "${active_temporary}" "${active}"
printf 'deployment ready: %s revision=0 manifest=%s\n' "${deployment_id}" "${manifest}"
