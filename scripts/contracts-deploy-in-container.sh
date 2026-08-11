#!/usr/bin/env bash
set -euo pipefail

: "${RPC_URL:?}"
: "${GENERATION:?}"
: "${GENESIS_CID:?}"
: "${CHAIN_ID:?}"
: "${EPOCH:?}"
: "${PROVIDER:?}"
: "${PROOF_BACKEND:?}"
: "${OUTPUT_MANIFEST:?}"
: "${DEPLOYMENT_ID:?}"
: "${DEPLOYMENT_ROOT:?}"
: "${POREP_TARGET_ROOT:?}"
: "${TARGET_JSON:?}"

lotus_rpc_url="${RPC_URL}"
FILECOIN_RPC_UPSTREAM="${lotus_rpc_url}" FILECOIN_RPC_PROXY_PORT=1235 \
  node /workspace/scripts/filecoin-rpc-proxy.mjs &
proxy_pid="$!"
trap 'kill "${proxy_pid}" 2>/dev/null || true' EXIT
for _ in {1..20}; do
  curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:1235 >/dev/null 2>&1 && break
  sleep 0.1
done
kill -0 "${proxy_pid}"
RPC_URL=http://127.0.0.1:1235

deployer_key="$(tr -d '\r\n[:space:]' < /run/secrets/deployer-key)"
[[ "${deployer_key}" =~ ^0x[0-9a-fA-F]{64}$ ]] || {
  printf 'invalid DevNet deployer key\n' >&2
  exit 1
}
deployer="$(cast wallet address --private-key "${deployer_key}")"
filecoin_deployer="$(
  cast rpc --rpc-url "${lotus_rpc_url}" Filecoin.EthAddressToFilecoinAddress \
    "\"${deployer}\"" |
    jq -r '.'
)"
[[ "${filecoin_deployer}" == t410f* || "${filecoin_deployer}" == f410f* ]] || {
  printf 'could not resolve DevNet deployer Filecoin address\n' >&2
  exit 1
}
runtime_root=/workspace/.runtime/contracts
deployment_root="${DEPLOYMENT_ROOT}"
log_file="${deployment_root}/deploy.log"
mkdir -p "${runtime_root}/work" "${deployment_root}/native" "${deployment_root}/revisions"
: > "${log_file}"

wait_for_deployer_mempool() {
  local latest pending filecoin_pending pending_json
  for _ in {1..120}; do
    latest="$(cast nonce --rpc-url "${RPC_URL}" "${deployer}")"
    pending="$(cast nonce --rpc-url "${RPC_URL}" --block pending "${deployer}")"
    pending_json="$(cast rpc --rpc-url "${lotus_rpc_url}" Filecoin.MpoolPending '[null]' 2>/dev/null || printf '[]\n')"
    filecoin_pending="$(
      jq -r --arg from "${filecoin_deployer}" '
        [ .[] | select((.Message.From // "") == $from) ] | length
      ' <<<"${pending_json}" 2>/dev/null || printf '1\n'
    )"
    [[ "${latest}" == "${pending}" && "${filecoin_pending}" == 0 ]] && return 0
    sleep 1
  done
  printf 'deployer mempool did not clear within 120 seconds\n' >&2
  return 1
}

wait_for_deployer_settlement() {
  local stable_required=5 stable_seen=0 previous_nonce="" latest pending filecoin_pending pending_json
  printf 'waiting for DevNet deployer mpool to settle after contracts-bootstrap\n' >>"${log_file}"
  for _ in {1..180}; do
    latest="$(cast nonce --rpc-url "${RPC_URL}" "${deployer}")"
    pending="$(cast nonce --rpc-url "${RPC_URL}" --block pending "${deployer}")"
    pending_json="$(cast rpc --rpc-url "${lotus_rpc_url}" Filecoin.MpoolPending '[null]' 2>/dev/null || printf '[]\n')"
    filecoin_pending="$(
      jq -r --arg from "${filecoin_deployer}" '
        [ .[] | select((.Message.From // "") == $from) ] | length
      ' <<<"${pending_json}" 2>/dev/null || printf '1\n'
    )"
    if [[ "${latest}" == "${pending}" && "${filecoin_pending}" == 0 && "${latest}" == "${previous_nonce}" ]]; then
      stable_seen=$((stable_seen + 1))
      if ((stable_seen >= stable_required)); then
        printf 'DevNet deployer mpool settled at nonce %s\n' "${latest}" >>"${log_file}"
        return 0
      fi
    else
      stable_seen=0
      previous_nonce="${latest}"
    fi
    sleep 3
  done
  printf 'deployer mpool did not remain stable after contracts-bootstrap\n' >&2
  return 1
}

deploy_contract() {
  local root="$1" target="$2"
  shift 2
  local output address
  wait_for_deployer_mempool
  output="$(forge create "${target}" --root "${root}" --rpc-url "${RPC_URL}" \
    --private-key "${deployer_key}" --broadcast --json "$@" 2>>"${log_file}")"
  wait_for_deployer_mempool
  address="$(jq -r '.deployedTo // empty' <<<"${output}")"
  [[ "${address}" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
    printf 'deployment failed for %s\n' "${target}" >&2
    exit 1
  }
  printf '%s\n' "${address}"
}

send() {
  wait_for_deployer_mempool
  cast send --rpc-url "${RPC_URL}" --private-key "${deployer_key}" "$@" >>"${log_file}" 2>&1
  wait_for_deployer_mempool
}

role_key() {
  cast keccak "porep-market-curio-devnet:${GENERATION}:$1"
}

declare -A identity_keys identity_addresses
wait_for_deployer_settlement
for role in client providerPayee porepService operator allocator oracle unauthorized; do
  identity_keys["${role}"]="$(role_key "${role}")"
  identity_addresses["${role}"]="$(cast wallet address --private-key "${identity_keys[${role}]}")"
  send "${identity_addresses[${role}]}" --value 10ether
done

identities_private="${deployment_root}/identities.private.json"
jq -n \
  --arg deployer "${deployer_key}" \
  --arg client "${identity_keys[client]}" \
  --arg providerPayee "${identity_keys[providerPayee]}" \
  --arg porepService "${identity_keys[porepService]}" \
  --arg operator "${identity_keys[operator]}" \
  --arg allocator "${identity_keys[allocator]}" \
  --arg oracle "${identity_keys[oracle]}" \
  --arg unauthorized "${identity_keys[unauthorized]}" \
  '{deployer:$deployer,client:$client,providerPayee:$providerPayee,porepService:$porepService,operator:$operator,allocator:$allocator,oracle:$oracle,unauthorized:$unauthorized}' \
  > "${identities_private}"
chmod 600 "${identities_private}"

harness_root=/workspace/contracts
mock_usdc="$(deploy_contract "${harness_root}" src/MockUSDC.sol:MockUSDC)"
termination_oracle="$(deploy_contract "${harness_root}" src/TerminationOracle.sol:TerminationOracle)"
miner_id="${PROVIDER#t0}"
expected_miner="$(printf '0xff%038x' "${miner_id}")"
notification_receiver="$(
  deploy_contract "${harness_root}" src/NotificationReceiver.sol:NotificationReceiver \
    --constructor-args "${expected_miner}"
)"
failing_notification_receiver="$(
  deploy_contract "${harness_root}" src/FailingNotificationReceiver.sol:FailingNotificationReceiver \
    --constructor-args "${expected_miner}"
)"
send "${mock_usdc}" 'mint(address,uint256)' "${identity_addresses[client]}" 1000000000000000
send "${mock_usdc}" 'mint(address,uint256)' "${deployer}" 1000000000000000

filecoin_pay_root="${deployment_root}/work/filecoin-pay"
meta_root="${deployment_root}/work/metaallocator"
porep_root="${POREP_TARGET_ROOT}"

filecoin_pay="$(deploy_contract "${filecoin_pay_root}" src/FilecoinPayV1.sol:FilecoinPayV1)"
allocator_impl="$(deploy_contract "${meta_root}" src/Allocator.sol:Allocator)"
allocator_factory="$(
  deploy_contract "${meta_root}" src/Factory.sol:Factory \
    --constructor-args "${deployer}" "${allocator_impl}"
)"
send "${allocator_factory}" 'deploy(address)' "${deployer}"
meta_allocator="$(cast call --rpc-url "${RPC_URL}" "${allocator_factory}" 'contracts(uint256)(address)' 0)"

export PRIVATE_KEY
printf -v PRIVATE_KEY '%s' "${deployer_key}"
export TERMINATION_ORACLE="${termination_oracle}"
export FILECOIN_PAY="${filecoin_pay}"
export ORACLE="${identity_addresses[oracle]}"
export POREP_SERVICE="${identity_addresses[porepService]}"
export OPERATOR_ADDR="${identity_addresses[operator]}"
export META_ALLOCATOR="${meta_allocator}"
porep_pending_dir="${porep_root}/.deployment/devnet"
porep_pending="${porep_pending_dir}/pending-deploy.json"
mkdir -p "${porep_pending_dir}"
jq -n '{result:{}}' >"${porep_pending}"
(
  cd "${porep_root}"
  forge build --build-info --extra-output storageLayout >>"${log_file}" 2>&1
  shopt -s nullglob
  build_info_files=(out/build-info/*.json)
  [[ "${#build_info_files[@]}" == 1 ]] || {
    printf 'PoRep build must produce exactly one build-info file\n' >&2
    exit 1
  }
  export BUILD_INFO_SHA256="0x$(sha256sum "${build_info_files[0]}" | awk '{print $1}')"
  export DEPLOYMENT_OUTPUT=.deployment/devnet/pending-deploy.json
  forge script script/Deploy.s.sol:Deploy --gas-estimate-multiplier 100000 \
    --disable-block-gas-limit --broadcast --slow \
    --rpc-url http://127.0.0.1:1235 \
    --private-key "${deployer_key}" >>"${log_file}" 2>&1
)
porep_json="${deployment_root}/native/porep-market.json"
[[ -f "${porep_pending}" ]] || {
  printf 'PoRep deployment manifest was not created\n' >&2
  exit 1
}
jq --arg finalizedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.result | .status="finalized" | .finalizedAt=$finalizedAt' \
  "${porep_pending}" >"${porep_json}"

po_rep_market="$(jq -r '.contracts.PoRepMarket.proxy' "${porep_json}")"
po_rep_market_impl="$(jq -r '.contracts.PoRepMarket.implementation' "${porep_json}")"
data_cap_adapter="$(jq -r '.contracts.DataCapEvidenceAdapter.proxy' "${porep_json}")"
data_cap_adapter_impl="$(jq -r '.contracts.DataCapEvidenceAdapter.implementation' "${porep_json}")"
validator_factory="$(jq -r '.contracts.ValidatorFactory.proxy' "${porep_json}")"
validator_factory_impl="$(jq -r '.contracts.ValidatorFactory.implementation' "${porep_json}")"
validator_beacon="$(jq -r '.contracts.ValidatorBeacon.address' "${porep_json}")"
validator_impl="$(jq -r '.contracts.Validator.implementation' "${porep_json}")"
sp_registry="$(jq -r '.contracts.SPRegistry.proxy' "${porep_json}")"
sp_registry_impl="$(jq -r '.contracts.SPRegistry.implementation' "${porep_json}")"
sli_oracle="$(jq -r '.contracts.SLIOracle.proxy' "${porep_json}")"
sli_oracle_impl="$(jq -r '.contracts.SLIOracle.implementation' "${porep_json}")"
sli_scorer="$(jq -r '.contracts.SLIScorer.proxy' "${porep_json}")"
sli_scorer_impl="$(jq -r '.contracts.SLIScorer.implementation' "${porep_json}")"
sector_status_inspector="$(
  deploy_contract "${porep_root}" \
    src/helpers/PoRepMarketSectorStatusInspector.sol:PoRepMarketSectorStatusInspector \
    --constructor-args "${po_rep_market}"
)"

send "${meta_allocator}" 'addAllowance(address,uint256)' "${data_cap_adapter}" 999999999999999999
send "${sp_registry}" 'setPaymentToken(address,bool,uint256)' "${mock_usdc}" true 1
send "${sp_registry}" 'registerProviderFor(uint64,address,uint256,address)' \
  "${miner_id}" "${identity_addresses[operator]}" 1099511627776 "${identity_addresses[providerPayee]}"
send "${sp_registry}" \
  'createOffer(uint64,(uint256,uint256,uint64,uint64),(uint16,uint64,uint16,uint8),(address,bool,uint256)[])' \
  "${miner_id}" '(1,0,0,0)' '(9000,1048576,1000,100)' "[(${mock_usdc},true,1000000)]"

contracts_tsv="${deployment_root}/contracts.tsv"
: > "${contracts_tsv}"
while IFS=$'\t' read -r name address kind implementation; do
  code="$(cast code --rpc-url "${RPC_URL}" "${address}")"
  [[ "${code}" =~ ^0x[0-9a-fA-F]+$ && "${code}" != "0x" ]] || {
    printf 'missing code for %s at %s\n' "${name}" "${address}" >&2
    exit 1
  }
  code_hash="$(cast keccak "${code}")"
  [[ "${code_hash}" =~ ^0x[0-9a-fA-F]{64}$ ]] || {
    printf 'invalid code hash for %s at %s\n' "${name}" "${address}" >&2
    exit 1
  }
  implementation_hash=""
  if [[ -n "${implementation}" ]]; then
    implementation_code="$(cast code --rpc-url "${RPC_URL}" "${implementation}")"
    [[ "${implementation_code}" =~ ^0x[0-9a-fA-F]+$ && "${implementation_code}" != "0x" ]] || {
      printf "missing implementation code for %s\n" "${name}" >&2
      exit 1
    }
    implementation_hash="$(cast keccak "${implementation_code}")"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${name}" "${address}" "${code_hash}" "${kind}" "${implementation}" "${implementation_hash}" \
    >>"${contracts_tsv}"
done <<EOF
MockUSDC	${mock_usdc}	direct
FilecoinPay	${filecoin_pay}	direct
MetaAllocator	${meta_allocator}	direct
AllocatorFactory	${allocator_factory}	direct
PoRepMarket	${po_rep_market}	uups	${po_rep_market_impl}
PoRepMarketImplementation	${po_rep_market_impl}	direct
DataCapEvidenceAdapter	${data_cap_adapter}	uups	${data_cap_adapter_impl}
DataCapEvidenceAdapterImplementation	${data_cap_adapter_impl}	direct
ValidatorFactory	${validator_factory}	uups	${validator_factory_impl}
ValidatorFactoryImplementation	${validator_factory_impl}	direct
ValidatorBeacon	${validator_beacon}	beacon	${validator_impl}
ValidatorImplementation	${validator_impl}	direct
SPRegistry	${sp_registry}	uups	${sp_registry_impl}
SPRegistryImplementation	${sp_registry_impl}	direct
SLIOracle	${sli_oracle}	uups	${sli_oracle_impl}
SLIOracleImplementation	${sli_oracle_impl}	direct
SLIScorer	${sli_scorer}	uups	${sli_scorer_impl}
SLIScorerImplementation	${sli_scorer_impl}	direct
TerminationOracle	${termination_oracle}	direct
NotificationReceiver	${notification_receiver}	direct
FailingNotificationReceiver	${failing_notification_receiver}	direct
SectorStatusInspector	${sector_status_inspector}	direct
EOF

contracts_json="$(jq -Rn '
  [inputs | split("\t") | {
    key: .[0],
    value: ({address: .[1], runtimeCodeHash: .[2], kind: .[3]}
      + if .[4] == "" then {} else {
          implementation: .[4],
          implementationCodeHash: .[5]
        } end)
  }]
  | from_entries
' < "${contracts_tsv}")"
jq -n \
  --arg deploymentId "${DEPLOYMENT_ID}" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg generation "${GENERATION}" \
  --arg genesisCid "${GENESIS_CID}" \
  --argjson chainId "${CHAIN_ID}" \
  --argjson epoch "${EPOCH}" \
  --arg provider "${PROVIDER}" \
  --arg proofBackend "${PROOF_BACKEND}" \
  --slurpfile target "${TARGET_JSON}" \
  --arg deployer "${deployer}" \
  --arg client "${identity_addresses[client]}" \
  --arg providerPayee "${identity_addresses[providerPayee]}" \
  --arg porepService "${identity_addresses[porepService]}" \
  --arg operator "${identity_addresses[operator]}" \
  --arg allocator "${identity_addresses[allocator]}" \
  --arg oracle "${identity_addresses[oracle]}" \
  --arg unauthorized "${identity_addresses[unauthorized]}" \
  --argjson contracts "${contracts_json}" \
  '{
    schemaVersion:2,
    deploymentId:$deploymentId,
    revision:0,
    parentRevision:null,
    generatedAt:$generatedAt,
    chain:{
      generation:$generation,
      genesisCid:$genesisCid,
      chainId:$chainId,
      epoch:$epoch,
      provider:$provider
    },
    proof:{backend:$proofBackend},
    target:$target[0],
    identities:{
      deployer:$deployer,
      client:$client,
      providerPayee:$providerPayee,
      porepService:$porepService,
      operator:$operator,
      allocator:$allocator,
      oracle:$oracle,
      unauthorized:$unauthorized
    },
    contracts:$contracts,
    transactions:[]
  }' > "${OUTPUT_MANIFEST}"
