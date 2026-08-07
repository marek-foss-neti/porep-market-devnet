#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_command jq
devnet_require_runtime_tree

source_arg="${1:-}"
source_arg="${source_arg#source=}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
seed="contract-tests-${timestamp}-$$"
target_args=(contract-target prepare "${seed}")
if [[ -n "${source_arg}" ]]; then
  [[ "${source_arg}" == /* ]] || devnet_die "PoRep Market source must be an absolute path"
  target_args+=(--source "${source_arg}")
fi
target_json="$(npm --silent --prefix "${DEVNET_ROOT}/tools" run cli -- "${target_args[@]}")"
target_root="$(jq -r '.snapshotPath' <<<"${target_json}")"
[[ -d "${target_root}" && ! -L "${target_root}" ]] ||
  devnet_die "prepared PoRep Market test target is unavailable"

source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"
platform="$(jq -r '.platform' "${DEVNET_BUILD_DIR}/images.json")"

node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 1800000 -- \
  docker run --rm --platform "${platform}" \
  --entrypoint forge \
  -v "${target_root}:/workspace:rw" \
  -w /workspace \
  "${image}" test
