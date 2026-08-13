#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"
devnet_require_command docker
devnet_require_command lsof
backend="$(devnet_requested_proof_backend "${1:-}")"
sector_size="$(devnet_requested_sector_size "${2:-}")"
[[ -f "${DEVNET_COMPOSE}" ]] || devnet_die "compose file is missing"
devnet_prepare_runtime
devnet_require_runtime_identity "${backend}" "${sector_size}"
devnet_write_compose_env
devnet_quarantine_mismatched_stacked_parameter_cache "${sector_size}"
devnet_check_start_ports
devnet_inspect_rendered_compose >/dev/null
devnet_progress "devnet-up: starting ${backend} containers with ${sector_size} sectors"
node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${DEVNET_LIFECYCLE_TIMEOUT_MS}" -- \
  bash -c 'source "$1"; devnet_compose up --detach' devnet-up "${DEVNET_ROOT}/scripts/devnet-common.sh"
market_config_timeout_seconds="$(devnet_curio_market_config_timeout_seconds "${sector_size}")"
market_config_timeout_label="$(devnet_format_duration_seconds "${market_config_timeout_seconds}")"
devnet_progress "devnet-up: containers are up; waiting for Curio market config (timeout=${market_config_timeout_label})"
case "${sector_size}" in
  512mib|32gib)
    devnet_progress "devnet-up: large-sector startup may fetch production proof params before Curio is ready; cache=$(devnet_proof_parameter_cache_label)"
    ;;
esac

[[ -n "${DEVNET_TEST_COMMAND_LOG:-}" ]] && exit 0

progress_last=0
market_config_started="${SECONDS}"
while ((SECONDS - market_config_started < market_config_timeout_seconds)); do
  config_state="$(
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -At -c "
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM curio.harmony_config
          WHERE title = 'market'
            AND config LIKE '%ParkPieceMinFreeStoragePercent = 0%'
            AND config LIKE '%SSRFAllowedHosts = [\"piece-server:12320\"]%'
        ) THEN 'configured'
        WHEN EXISTS (
          SELECT 1 FROM curio.harmony_config WHERE title = 'market'
        ) THEN 'pending'
        ELSE 'absent'
      END
    " 2>/dev/null || true
  )"
  elapsed="$((SECONDS - market_config_started))"
  progress_message="devnet-up: Curio market config state=${config_state:-unknown}; elapsed=$(devnet_format_duration_seconds "${elapsed}")/${market_config_timeout_label}"
  case "${sector_size}" in
    512mib|32gib)
      progress_message="${progress_message}; proof-cache=$(devnet_proof_parameter_cache_label)"
      recent_parameter="$(devnet_recent_proof_parameter_label)"
      [[ -z "${recent_parameter}" ]] || progress_message="${progress_message}; latest=${recent_parameter}"
      ;;
  esac
  devnet_progress_maybe progress_last "${progress_message}"
  if [[ "${config_state}" == "pending" ]]; then
    devnet_progress "devnet-up: applying Curio market config overrides"
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -q -c "
      UPDATE curio.harmony_config
      SET config = replace(
        config,
        E'[Ingest]\\n',
        E'[Ingest]\\n    SSRFAllowedHosts = [\"piece-server:12320\"]\\n'
      )
      WHERE title = 'market'
        AND config NOT LIKE '%SSRFAllowedHosts%'
    " >/dev/null 2>&1 || { sleep 2; continue; }
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -q -c "
      UPDATE curio.harmony_config
      SET config = replace(
        config,
        E'[Subsystems]\\n',
        E'[Subsystems]\\n    ParkPieceMinFreeStoragePercent = 0\\n'
      )
      WHERE title = 'market'
        AND config NOT LIKE '%ParkPieceMinFreeStoragePercent%'
    " >/dev/null 2>&1 || { sleep 2; continue; }
    devnet_progress "devnet-up: restarting Curio after market config overrides"
    devnet_compose restart curio >/dev/null
    devnet_progress "devnet-up: Curio restart requested"
    exit 0
  fi
  if [[ "${config_state}" == "configured" ]]; then
    devnet_progress "devnet-up: Curio market config is configured"
    exit 0
  fi
  sleep 2
done

devnet_die "Curio market config was not created within ${market_config_timeout_label}"
