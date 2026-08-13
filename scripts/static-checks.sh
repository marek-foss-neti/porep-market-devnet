#!/usr/bin/env bash
set -euo pipefail

if [[ -f versions.lock.yaml ]]; then
  build_files=(
    docker/curio-all-in-one.Dockerfile
    docker/lotus/Dockerfile
    docker/contracts-bootstrap/Dockerfile
    docker/lotus-miner/Dockerfile
    docker/curio/Dockerfile
    docker/piece-server/Dockerfile
    docker/indexer/Dockerfile
    scripts/devnet-common.sh
    scripts/devnet-build.sh
    scripts/devnet-up.sh
    scripts/devnet-down.sh
    scripts/devnet-reset.sh
    scripts/devnet-logs.sh
    scripts/contracts-test-target.sh
    scripts/devnet-upgrade.sh
    scripts/devnet-test-upgrade.sh
    scripts/bench-proof-backends.sh
    scripts/bench-proof-micro.sh
    docker/compose.curio-devnet.yaml
    source-overrides/curio/scripts/makefiles/10-deps.mk
    source-overrides/curio/cmd/sptool/toolbox_deal_client.go
    source-overrides/curio/lib/ffi/unseal_funcs.go
    source-overrides/curio/market/mk20/ddo_v1.go
    source-overrides/curio/tasks/piece/task_park_piece.go
    source-overrides/curio/tasks/unseal/task_unseal_decode.go
    source-overrides/curio/tasks/unseal/task_unseal_sdr.go
    source-overrides/filecoin-ffi/rust/Cargo.lock
    source-overrides/filecoin-ffi/rust/Cargo.toml
    source-overrides/filecoin-ffi/rust/src/bin/porep-proof-microbench.rs
    source-overrides/filecoin-ffi/rust/src/proofs/api.rs
    source-overrides/fvm-4.8.2-zigzag/Cargo.toml
    source-overrides/fvm-4.8.2-zigzag/src/account_actor.rs
    source-overrides/fvm-4.8.2-zigzag/src/kernel/filecoin.rs
    source-overrides/lotus/build/buildconstants/devnet_network_bundle.go
    source-overrides/lotus/entrypoint.sh
    tools/test/devnet.test.ts
  )
  for build_file in "${build_files[@]}"; do
    [[ -f "$build_file" && ! -L "$build_file" ]] || {
      echo "missing or symbolic build file: $build_file" >&2
      exit 1
    }
  done

  bash -n scripts/devnet-common.sh scripts/devnet-build.sh scripts/devnet-up.sh scripts/devnet-down.sh scripts/devnet-reset.sh scripts/devnet-logs.sh scripts/contracts-test-target.sh scripts/devnet-upgrade.sh scripts/devnet-test-upgrade.sh scripts/bench-proof-backends.sh scripts/bench-proof-micro.sh
  rg -q '^build:' justfile
  if rg -n -i \
    '(latest|@master|@main|foundryup|nodesource|git[[:space:]]+clone|git[[:space:]]+submodule[[:space:]]+update)' \
    docker/curio-all-in-one.Dockerfile \
    docker/lotus/Dockerfile \
    docker/contracts-bootstrap/Dockerfile \
    docker/lotus-miner/Dockerfile \
    docker/curio/Dockerfile \
    docker/piece-server/Dockerfile \
    docker/indexer/Dockerfile \
    scripts/devnet-build.sh; then
    echo 'floating or remote build input found' >&2
    exit 1
  fi
  if rg -n '^[[:space:]]*VOLUME([[:space:]]|$)' \
    docker/curio-all-in-one.Dockerfile \
    docker/lotus/Dockerfile \
    docker/contracts-bootstrap/Dockerfile \
    docker/lotus-miner/Dockerfile \
    docker/curio/Dockerfile \
    docker/piece-server/Dockerfile \
    docker/indexer/Dockerfile; then
    echo 'project Dockerfile volume metadata found' >&2
    exit 1
  fi
fi

git check-ignore -q .cache/sources/example/deadbeef
git check-ignore -q .runtime/deployments/example.json
git check-ignore -q tools/node_modules/example
git check-ignore -q .env
git check-ignore --no-index -q .npmrc
git check-ignore --no-index -q .netrc

scan_paths=()
netrc_paths=()
while IFS= read -r path; do
  [[ -f "$path" ]] || continue
  [[ "$path" == scripts/static-checks.sh ]] && continue
  scan_paths+=("$path")
  if [[ "$path" == .netrc || "$path" == */.netrc ]]; then
    netrc_paths+=("$path")
  fi
done < <(
  git ls-files --cached --others --exclude-standard \
    ':(exclude,top).git/**' \
    ':(exclude,top).cache/**' \
    ':(exclude,top).runtime/**' \
    ':(exclude,glob)**/node_modules/**' \
    ':!docs/goals/**' \
    ':!docs/superpowers/plans/2026-07-24-phase-1-bootstrap-tooling.md' \
    ':!.superpowers/sdd/task-1-brief.md' \
    ':!.superpowers/sdd/task-1-report.md' \
    ':!.superpowers/sdd/phase2-task-2-report.md' \
    ':!docs/review/**'
)

if ((${#scan_paths[@]})); then
  user_path_root="/""Users/"
  curio_dir_name="CURIO_""DIR"
  if rg -l --fixed-strings "$user_path_root" "${scan_paths[@]}" ||
    rg -l --fixed-strings "$curio_dir_name" "${scan_paths[@]}" ||
    rg -l -i '(^|[[:space:]])([[:alnum:]_]*private[_-]?key)[[:space:]]*=' "${scan_paths[@]}" ||
    rg -l -i '(^|[[:space:]/:])_?auth(token)?[[:space:]]*=' "${scan_paths[@]}" ||
    rg -l 'while[[:space:]]+true([[:space:]]|;|$)' "${scan_paths[@]}"; then
    echo 'unsafe implementation text found' >&2
    exit 1
  fi
fi

if ((${#netrc_paths[@]})) && rg -l -i '(^|[[:space:]])password[[:space:]]+[^[:space:]]+' "${netrc_paths[@]}"; then
  echo 'unsafe implementation text found' >&2
  exit 1
fi
