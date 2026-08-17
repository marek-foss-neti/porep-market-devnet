#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command curl
devnet_require_command jq
devnet_require_command node
devnet_require_runtime_tree
devnet_require_ownership_marker
proof_backend="$(devnet_current_proof_backend)"
sector_size_selector="$(devnet_current_sector_size)"
expected_sector_size="$(devnet_sector_size_bytes "${sector_size_selector}")"
registered_seal_proof="$(devnet_registered_seal_proof_for_sector_size "${sector_size_selector}")"
actor_network_bundle="$(devnet_actor_network_bundle_for_sector_size "${sector_size_selector}")"
firehorse_epoch="$(devnet_firehorse_upgrade_epoch_for_sector_size "${sector_size_selector}")"
status_path="${DEVNET_ROOT}/.runtime/devnet/status/latest.json"
mkdir -p "$(dirname "${status_path}")"
# Keep ten seconds of margin below the documented 20-minute wall budget.
command_deadline=$((SECONDS + 1190))

running="$(
  node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 30000 -- \
    bash -c 'source "$1"; devnet_compose ps --quiet' devnet-status "${DEVNET_ROOT}/scripts/devnet-common.sh"
)"
[[ -n "${running}" ]] || devnet_die "project is not running; run just up"
devnet_progress "devnet-status: waiting for ${proof_backend} ${sector_size_selector} devnet readiness"

bounded_compose() {
  local remaining_seconds=$((deadline - SECONDS))
  ((remaining_seconds > 0)) || return 124
  local timeout_ms=$((remaining_seconds * 1000))
  ((timeout_ms > 30000)) && timeout_ms=30000
  node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${timeout_ms}" -- \
    bash -c 'source "$1"; shift; devnet_compose "$@"' devnet-status \
    "${DEVNET_ROOT}/scripts/devnet-common.sh" "$@"
}

probe_timeout_seconds() {
  local remaining_seconds=$((deadline - SECONDS))
  ((remaining_seconds > 0)) || return 124
  ((remaining_seconds > 30)) && remaining_seconds=30
  printf '%s\n' "${remaining_seconds}"
}

status_pause() {
  local remaining_seconds=$((deadline - SECONDS))
  ((remaining_seconds > 0)) || return 1
  ((remaining_seconds > 5)) && remaining_seconds=5
  sleep "${remaining_seconds}"
}

collect_compose_status() {
  compose_json="$(bounded_compose ps --all --format json 2>/dev/null || true)"
  compose_status="$(jq -sc '
    map({
      service: .Service,
      state: .State,
      health: (.Health // ""),
      exitCode: (.ExitCode // 0)
    }) | sort_by(.service)
  ' <<<"${compose_json}" 2>/dev/null || true)"
}

compose_status_ready() {
  [[ "$(jq -r '
    all(.[]; if .service == "contracts-bootstrap" then
      (.state == "exited" and .exitCode == 0)
    else
      (.state == "running" and .health == "healthy")
    end)
  ' <<<"${compose_status:-[]}" 2>/dev/null || true)" == true ]]
}

compose_status_summary() {
  jq -r '
    map(if .service == "contracts-bootstrap" then
      "\(.service)=\(.state)/exit\(.exitCode)"
    else
      "\(.service)=\(.state)/\(.health)"
    end) | join(", ")
  ' <<<"${compose_status:-[]}" 2>/dev/null ||
    printf 'compose services are not yet healthy\n'
}

diagnostic_timeout_ms() {
  local remaining_seconds=$((command_deadline - SECONDS))
  ((remaining_seconds > 0)) || return 124
  ((remaining_seconds > 30)) && remaining_seconds=30
  printf '%s\n' "$((remaining_seconds * 1000))"
}

capture_diagnostics() {
  local diagnostic_dir="${DEVNET_LOG_DIR}/status-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${diagnostic_dir}"
  local timeout_ms
  if timeout_ms="$(diagnostic_timeout_ms)"; then
    node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${timeout_ms}" -- \
      bash -c 'source "$1"; devnet_compose ps --all --format json' devnet-status \
      "${DEVNET_ROOT}/scripts/devnet-common.sh" > "${diagnostic_dir}/compose-ps.ndjson" 2>&1 || true
  fi
  if timeout_ms="$(diagnostic_timeout_ms)"; then
    node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${timeout_ms}" -- \
      bash -c 'source "$1"; devnet_compose logs --no-color --tail 200' devnet-status \
      "${DEVNET_ROOT}/scripts/devnet-common.sh" > "${diagnostic_dir}/compose.log" 2>&1 || true
  fi
  printf '%s\n' "${diagnostic_dir}"
}

# Reserve the final 65 seconds of the absolute budget for diagnostics.
deadline=$((command_deadline - 65))
last_state="startup has not converged"
status_progress_last=0
while ((SECONDS < deadline)); do
  collect_compose_status
  if [[ "$(jq 'length' <<<"${compose_status:-[]}" 2>/dev/null || printf 0)" != 7 ]]; then
    last_state="expected seven Compose services"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi
  if ! compose_status_ready; then
    last_state="$(compose_status_summary)"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi

  epoch="$(bounded_compose exec -T lotus lotus chain head --height 2>/dev/null || true)"
  network_output="$(bounded_compose exec -T lotus lotus state network-version 2>/dev/null || true)"
  network_version="$(awk '/Network Version:/ {print $3}' <<<"${network_output}")"
  if [[ ! "${epoch}" =~ ^[0-9]+$ || ! "${network_version}" =~ ^[0-9]+$ || "${epoch}" -lt "${firehorse_epoch}" || "${network_version}" -ne 28 ]]; then
    last_state="chain epoch=${epoch:-unknown} networkVersion=${network_version:-unknown}; waiting for epoch ${firehorse_epoch}/NV28"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi

  actor_output="$(bounded_compose exec -T lotus lotus state actor-cids 2>/dev/null || true)"
  actors_version="$(awk '/Actor Version:/ {print $3}' <<<"${actor_output}")"
  manifest_cid="$(awk '/Manifest CID:/ {print $3}' <<<"${actor_output}")"
  miner_actor_cid="$(awk '$1 == "storageminer" {print $2}' <<<"${actor_output}")"
  provider="$(bounded_compose exec -T lotus lotus state list-miners 2>/dev/null | awk '$1 != "t01000" {print $1}' | head -1 || true)"

  curl_timeout="$(probe_timeout_seconds)" || continue
  chain_id="$(curl --silent --show-error --max-time "${curl_timeout}" \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:2234/rpc/v1 2>/dev/null | jq -r '.result // empty' || true)"
  miner_request="$(jq -nc --arg provider "${provider}" \
    '{jsonrpc:"2.0",id:1,method:"Filecoin.StateMinerInfo",params:[$provider,null]}')"
  curl_timeout="$(probe_timeout_seconds)" || continue
  miner_info="$(curl --silent --show-error --max-time "${curl_timeout}" \
    -H 'content-type: application/json' \
    --data "${miner_request}" \
    http://127.0.0.1:2234/rpc/v1 2>/dev/null || true)"
  owner="$(jq -r '.result.Owner // empty' <<<"${miner_info}" 2>/dev/null || true)"
  worker="$(jq -r '.result.Worker // empty' <<<"${miner_info}" 2>/dev/null || true)"
  control_addresses="$(jq -c '.result.ControlAddresses // []' <<<"${miner_info}" 2>/dev/null || true)"
  sector_size="$(jq -r '.result.SectorSize // empty' <<<"${miner_info}" 2>/dev/null || true)"
  curio_version="$(bounded_compose exec -T curio curio --version 2>/dev/null || true)"
  api_ready=false
  bounded_compose exec -T curio curio cli --machine curio:12300 info >/dev/null 2>&1 && api_ready=true
  market_ready=false
  curl_timeout="$(probe_timeout_seconds)" || continue
  market_health="$(curl --silent --show-error --fail --max-time "${curl_timeout}" \
    http://127.0.0.1:22310/health 2>/dev/null || true)"
  [[ "${market_health}" == "Service is up and running" ]] && market_ready=true
  task_count="$(bounded_compose exec -T yugabyte bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -Atc \
    'select count(*) from curio.harmony_task;' 2>/dev/null | tail -1 || true)"
  lotus_fil_proofs_use_zigzag="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_USE_ZIGZAG:-}"' 2>/dev/null || true)"
  lotus_actor_network_bundle="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${LOTUS_DEVNET_NETWORK_BUNDLE:-}"' 2>/dev/null || true)"
  curio_fil_proofs_use_zigzag="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_USE_ZIGZAG:-}"' 2>/dev/null || true)"
  curio_zigzag_generate_missing_params="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS:-}"' 2>/dev/null || true)"
  lotus_zigzag_sidecar_dir="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_ZIGZAG_SIDECAR_DIR:-}"' 2>/dev/null || true)"
  curio_zigzag_sidecar_dir="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_ZIGZAG_SIDECAR_DIR:-}"' 2>/dev/null || true)"
  lotus_parent_cache="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_PARENT_CACHE:-}"' 2>/dev/null || true)"
  curio_parent_cache="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_PARENT_CACHE:-}"' 2>/dev/null || true)"
  lotus_use_zigzag_parent_cache="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE:-}"' 2>/dev/null || true)"
  curio_use_zigzag_parent_cache="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE:-}"' 2>/dev/null || true)"
  lotus_zigzag_parent_cache_size="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE:-}"' 2>/dev/null || true)"
  curio_zigzag_parent_cache_size="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE:-}"' 2>/dev/null || true)"
  lotus_sdr_parents_cache_size="$(bounded_compose exec -T lotus sh -c \
    'printf "%s" "${FIL_PROOFS_SDR_PARENTS_CACHE_SIZE:-}"' 2>/dev/null || true)"
  curio_sdr_parents_cache_size="$(bounded_compose exec -T curio sh -c \
    'printf "%s" "${FIL_PROOFS_SDR_PARENTS_CACHE_SIZE:-}"' 2>/dev/null || true)"
  expected_zigzag="$(devnet_fil_proofs_use_zigzag "${proof_backend}")"
  expected_generate_missing_params="$(devnet_fil_proofs_zigzag_generate_missing_params "${proof_backend}")"
  expected_sidecar_dir="/var/tmp/filecoin-zigzag-proof-sidecars"
  expected_parent_cache="/var/tmp/filecoin-parents"
  expected_parent_cache_window_nodes="$(awk -F= '$1 == "FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE" {print substr($0, index($0, "=") + 1); exit}' "${DEVNET_COMPOSE_ENV}")"
  [[ "${expected_parent_cache_window_nodes}" =~ ^[0-9]+$ && "${expected_parent_cache_window_nodes}" -ge 1 ]] ||
    expected_parent_cache_window_nodes="$(devnet_parent_cache_window_nodes)"

  build_curio="$(jq -r '.curioCommit' "${DEVNET_BUILD_DIR}/images.json")"
  build_lotus="$(jq -r '.lotusCommit' "${DEVNET_BUILD_DIR}/images.json")"
  build_rust_fil_proofs="$(jq -r '.rustFilProofsCommit // empty' "${DEVNET_BUILD_DIR}/images.json")"
  build_platform="$(jq -r '.platform' "${DEVNET_BUILD_DIR}/images.json")"
  generation="$(tr -d '\n' < "${DEVNET_RUNTIME_DIR}/generation" 2>/dev/null || true)"

  if [[
    "${actors_version}" != 18
    || -z "${manifest_cid}"
    || -z "${miner_actor_cid}"
    || ! "${provider}" =~ ^t0[0-9]+$
    || -z "${owner}"
    || -z "${worker}"
    || "$(jq -r 'type == "array" and all(.[]; type == "string" and length > 0)' <<<"${control_addresses:-null}" 2>/dev/null || true)" != true
    || "${sector_size}" != "${expected_sector_size}"
    || -z "${chain_id}"
    || "${lotus_actor_network_bundle}" != "${actor_network_bundle}"
    || "${curio_version}" != *"${build_curio}"*
    || ! "${build_rust_fil_proofs}" =~ ^[0-9a-f]{40}$
    || "${api_ready}" != true
    || "${market_ready}" != true
    || ! "${task_count}" =~ ^[0-9]+$
    || "${lotus_fil_proofs_use_zigzag}" != "${expected_zigzag}"
    || "${curio_fil_proofs_use_zigzag}" != "${expected_zigzag}"
    || "${curio_zigzag_generate_missing_params}" != "${expected_generate_missing_params}"
    || "${lotus_zigzag_sidecar_dir}" != "${expected_sidecar_dir}"
    || "${curio_zigzag_sidecar_dir}" != "${expected_sidecar_dir}"
    || "${lotus_parent_cache}" != "${expected_parent_cache}"
    || "${curio_parent_cache}" != "${expected_parent_cache}"
    || "${lotus_use_zigzag_parent_cache}" != "${expected_zigzag}"
    || "${curio_use_zigzag_parent_cache}" != "${expected_zigzag}"
    || "${lotus_zigzag_parent_cache_size}" != "${expected_parent_cache_window_nodes}"
    || "${curio_zigzag_parent_cache_size}" != "${expected_parent_cache_window_nodes}"
    || "${lotus_sdr_parents_cache_size}" != "${expected_parent_cache_window_nodes}"
    || "${curio_sdr_parents_cache_size}" != "${expected_parent_cache_window_nodes}"
    || -z "${generation}"
  ]]; then
    last_state="semantic probes incomplete at epoch ${epoch}"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi

  collect_compose_status
  if [[ "$(jq 'length' <<<"${compose_status:-[]}" 2>/dev/null || printf 0)" != 7 ]]; then
    last_state="expected seven Compose services before status write"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi
  if ! compose_status_ready; then
    last_state="$(compose_status_summary)"
    devnet_progress_maybe status_progress_last "devnet-status: ${last_state}; elapsed=${SECONDS}s"
    status_pause || break
    continue
  fi

  temporary="${status_path}.temporary.$$"
  jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg generation "${generation}" \
    --arg buildCurio "${build_curio}" \
    --arg buildLotus "${build_lotus}" \
    --arg buildRustFilProofs "${build_rust_fil_proofs}" \
    --arg platform "${build_platform}" \
    --arg proofBackend "${proof_backend}" \
    --arg actorNetworkBundle "${actor_network_bundle}" \
    --arg sectorSizeSelector "${sector_size_selector}" \
    --arg registeredSealProof "${registered_seal_proof}" \
    --arg lotusZigZag "${lotus_fil_proofs_use_zigzag}" \
    --arg curioZigZag "${curio_fil_proofs_use_zigzag}" \
    --arg curioGenerateMissingParams "${curio_zigzag_generate_missing_params}" \
    --arg lotusSidecarDir "${lotus_zigzag_sidecar_dir}" \
    --arg curioSidecarDir "${curio_zigzag_sidecar_dir}" \
    --arg lotusParentCache "${lotus_parent_cache}" \
    --arg curioParentCache "${curio_parent_cache}" \
    --arg lotusUseZigZagParentCache "${lotus_use_zigzag_parent_cache}" \
    --arg curioUseZigZagParentCache "${curio_use_zigzag_parent_cache}" \
    --arg lotusZigZagParentCacheSize "${lotus_zigzag_parent_cache_size}" \
    --arg curioZigZagParentCacheSize "${curio_zigzag_parent_cache_size}" \
    --arg lotusSdrParentsCacheSize "${lotus_sdr_parents_cache_size}" \
    --arg curioSdrParentsCacheSize "${curio_sdr_parents_cache_size}" \
    --argjson compose "${compose_status}" \
    --arg chainId "${chain_id}" \
    --argjson epoch "${epoch}" \
    --argjson networkVersion "${network_version}" \
    --argjson actorsVersion "${actors_version}" \
    --arg manifestCid "${manifest_cid}" \
    --arg minerActorCodeCid "${miner_actor_cid}" \
    --arg provider "${provider}" \
    --arg owner "${owner}" \
    --arg worker "${worker}" \
    --argjson control "${control_addresses}" \
    --argjson sectorSize "${sector_size}" \
    --argjson taskCount "${task_count}" \
    '{
      schemaVersion: 1,
      generatedAt: $generatedAt,
      generation: $generation,
      build: {
        curioCommit: $buildCurio,
        lotusCommit: $buildLotus,
        rustFilProofsCommit: $buildRustFilProofs,
        platform: $platform
      },
      proof: {
        backend: $proofBackend,
        lotus: {
          FIL_PROOFS_USE_ZIGZAG: $lotusZigZag,
          FIL_PROOFS_ZIGZAG_SIDECAR_DIR: $lotusSidecarDir,
          FIL_PROOFS_PARENT_CACHE: $lotusParentCache,
          FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE: $lotusUseZigZagParentCache,
          FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE: $lotusZigZagParentCacheSize,
          FIL_PROOFS_SDR_PARENTS_CACHE_SIZE: $lotusSdrParentsCacheSize
        },
        curio: {
          FIL_PROOFS_USE_ZIGZAG: $curioZigZag,
          FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS: $curioGenerateMissingParams,
          FIL_PROOFS_ZIGZAG_SIDECAR_DIR: $curioSidecarDir,
          FIL_PROOFS_PARENT_CACHE: $curioParentCache,
          FIL_PROOFS_USE_ZIGZAG_PARENT_CACHE: $curioUseZigZagParentCache,
          FIL_PROOFS_ZIGZAG_PARENT_CACHE_SIZE: $curioZigZagParentCacheSize,
          FIL_PROOFS_SDR_PARENTS_CACHE_SIZE: $curioSdrParentsCacheSize
        }
      },
      sector: {
        selector: $sectorSizeSelector,
        bytes: $sectorSize,
        registeredSealProof: $registeredSealProof
      },
      compose: $compose,
      chain: {
        chainId: $chainId,
        epoch: $epoch,
        networkVersion: $networkVersion,
        actorsVersion: $actorsVersion,
        actorNetworkBundle: $actorNetworkBundle,
        manifestCid: $manifestCid,
        minerActorCodeCid: $minerActorCodeCid
      },
      miner: {
        provider: $provider,
        owner: $owner,
        worker: $worker,
        control: $control,
        sectorSize: $sectorSize
      },
      curio: {
        commit: $buildCurio,
        apiReady: true,
        marketReady: true,
        databaseReady: true,
        taskCount: $taskCount
      }
    }' > "${temporary}"
  npm --prefix "${DEVNET_ROOT}/tools" run cli -- devnet status inspect < "${temporary}"
  mv -- "${temporary}" "${status_path}"
  devnet_progress "devnet-status: ready backend=${proof_backend} sector=${sector_size_selector} epoch=${epoch} provider=${provider}"
  exit 0
done

diagnostic_dir="$(capture_diagnostics)"
devnet_die "status timed out after 20 minutes: ${last_state}; diagnostics: ${diagnostic_dir}"
