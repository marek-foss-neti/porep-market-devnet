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
    docker/compose.curio-devnet.yaml
    patches/curio/0003-zigzag-devnet-unseal.patch
    patches/filecoin-ffi/0002-zigzag-devnet-fvm4-path.patch
    patches/fvm/0001-zigzag-devnet-verifier.patch
    tools/test/devnet.test.ts
  )
  for build_file in "${build_files[@]}"; do
    [[ -f "$build_file" ]] || {
      echo "missing build file: $build_file" >&2
      exit 1
    }
  done

  bash -n scripts/devnet-common.sh scripts/devnet-build.sh scripts/devnet-up.sh scripts/devnet-down.sh scripts/devnet-reset.sh scripts/devnet-logs.sh scripts/contracts-test-target.sh scripts/devnet-upgrade.sh scripts/devnet-test-upgrade.sh scripts/bench-proof-backends.sh
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
    rg -l -i '\b(private[_-]?key)\s*=' "${scan_paths[@]}" ||
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
