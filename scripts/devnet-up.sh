#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"
devnet_require_command docker
devnet_require_command lsof
backend="$(devnet_requested_proof_backend "${1:-}")"
[[ -f "${DEVNET_COMPOSE}" ]] || devnet_die "compose file is missing"
devnet_prepare_runtime
devnet_require_proof_backend "${backend}"
devnet_write_compose_env
devnet_check_start_ports
devnet_inspect_rendered_compose >/dev/null
devnet_progress "devnet-up: starting ${backend} containers"
node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${DEVNET_LIFECYCLE_TIMEOUT_MS}" -- \
  bash -c 'source "$1"; devnet_compose up --detach' devnet-up "${DEVNET_ROOT}/scripts/devnet-common.sh"
devnet_progress "devnet-up: containers are up; waiting for Curio market config"

[[ -n "${DEVNET_TEST_COMMAND_LOG:-}" ]] && exit 0

progress_last=0
for _ in {1..150}; do
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
  devnet_progress_maybe progress_last "devnet-up: Curio market config state=${config_state:-unknown}; elapsed=${SECONDS}s"
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

devnet_die "Curio market config was not created within 300 seconds"
