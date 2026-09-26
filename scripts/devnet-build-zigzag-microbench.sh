#!/usr/bin/env bash
set -euo pipefail

source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"
cd "${DEVNET_ROOT}"
devnet_require_command docker
devnet_require_command jq
devnet_require_command npm
devnet_require_command shasum

[[ -n "${DEVNET_RUST_FIL_PROOFS_SOURCE:-}" ]] ||
  devnet_die "DEVNET_RUST_FIL_PROOFS_SOURCE must name the isolated ZigZag source"
[[ -z "${DEVNET_ZIGZAG_RUSTUP_TOOLCHAIN:-}" ]] ||
  devnet_die "the ZigZag toolchain is selected by its pinned image, not rustup"
zigzag_toolchain_image="${DEVNET_ZIGZAG_RUST_TOOLCHAIN_IMAGE:-docker.io/library/rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62}"
[[ "${zigzag_toolchain_image}" =~ @sha256:[0-9a-f]{64}$ ]] ||
  devnet_die "ZigZag toolchain image must be pinned by SHA-256"

source_verify_output="$(npm --prefix tools run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_verify_output}")"
lotus_commit="$(awk -F '\t' '$1 == "lotus" {print $3}' <<<"${source_verify_output}")"
blst_commit="$(awk -F '\t' '$1 == "blst" {print $3}' <<<"${source_verify_output}")"
rust_fil_proofs_commit="$(awk -F '\t' '$1 == "rust_fil_proofs" {print $3}' <<<"${source_verify_output}")"
[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ && "${lotus_commit}" =~ ^[0-9a-f]{40}$ && "${blst_commit}" =~ ^[0-9a-f]{40}$ && "${rust_fil_proofs_commit}" =~ ^[0-9a-f]{40}$ ]] ||
  devnet_die "managed source verification has invalid commits"
curio_source="$(devnet_curio_source_path "${curio_commit}")"
[[ -d "${curio_source}" && ! -L "${curio_source}" ]] ||
  devnet_die "managed Curio source is missing"
[[ "$(git -C "${curio_source}" rev-parse HEAD)" == "${curio_commit}" ]] ||
  devnet_die "managed Curio source commit differs from manifest"

zigzag_source="$(realpath "${DEVNET_RUST_FIL_PROOFS_SOURCE}")"
[[ "${zigzag_source}" == "${DEVNET_ROOT}/"* && -d "${zigzag_source}" && ! -L "${zigzag_source}" ]] ||
  devnet_die "ZigZag source must be a directory inside the devnet build context"
[[ "$(git -C "${zigzag_source}" rev-parse HEAD)" == "${rust_fil_proofs_commit}" ]] ||
  devnet_die "ZigZag source has a different base commit"
zigzag_source_relative="${zigzag_source#"${DEVNET_ROOT}/"}"
curio_source_relative=".cache/sources/curio/${curio_commit}"
zigzag_source_sha256="$(devnet_rust_fil_proofs_content_sha256 "${zigzag_source}")"
zigzag_overrides_sha256="$(devnet_zigzag_microbench_overrides_sha256)"
dockerfile_sha256="$(shasum -a 256 docker/zigzag-microbench.Dockerfile | awk '{print $1}')"
platform="linux/$(devnet_normalize_architecture "$(docker info --format '{{.Architecture}}')")"
image="${DEVNET_IMAGE_NAMESPACE}/zigzag-microbench:${zigzag_source_sha256:0:12}-${zigzag_overrides_sha256:0:12}"

docker buildx build \
  --load \
  --provenance=false \
  --platform "${platform}" \
  --progress plain \
  --file docker/zigzag-microbench.Dockerfile \
  --target zigzag-microbench \
  --build-context "curio-source=${curio_source_relative}" \
  --build-context "harness-overlay=." \
  --build-context "rust-fil-proofs=${zigzag_source_relative}" \
  --build-arg "ZIGZAG_RUST_TOOLCHAIN_IMAGE=${zigzag_toolchain_image}" \
  --build-arg "RUST_FIL_PROOFS_COMMIT=${rust_fil_proofs_commit}" \
  --build-arg "RUST_FIL_PROOFS_SOURCE_SHA256=${zigzag_source_sha256}" \
  --build-arg "ZIGZAG_SOURCE_OVERRIDES_SHA256=${zigzag_overrides_sha256}" \
  --tag "${image}" \
  "${curio_source_relative}"

image_id="$(docker image inspect "${image}" --format '{{.Id}}')"
[[ "$(docker image inspect "${image}" --format '{{index .Config.Labels "io.porep-market.zigzag.rust-fil-proofs.source-sha256"}}')" == "${zigzag_source_sha256}" ]] ||
  devnet_die "ZigZag image source digest label mismatch"
[[ "$(docker image inspect "${image}" --format '{{index .Config.Labels "io.porep-market.zigzag.source-overrides.sha256"}}')" == "${zigzag_overrides_sha256}" ]] ||
  devnet_die "ZigZag image override digest label mismatch"
[[ "$(docker image inspect "${image}" --format '{{index .Config.Labels "io.porep-market.zigzag.rust-toolchain.image"}}')" == "${zigzag_toolchain_image}" ]] ||
  devnet_die "ZigZag image toolchain label mismatch"

mkdir -p "${DEVNET_BUILD_DIR}"
manifest="${DEVNET_BUILD_DIR}/zigzag-microbench-images.json"
temporary="$(mktemp "${DEVNET_BUILD_DIR}/zigzag-microbench-images.json.XXXXXX")"
jq -n \
  --arg platform "${platform}" \
  --arg curioCommit "${curio_commit}" \
  --arg lotusCommit "${lotus_commit}" \
  --arg blstCommit "${blst_commit}" \
  --arg rustFilProofsCommit "${rust_fil_proofs_commit}" \
  --arg rustFilProofsSourceSha256 "${zigzag_source_sha256}" \
  --arg rustFilProofsSourceRelative "${zigzag_source_relative}" \
  --arg rustToolchainImage "${zigzag_toolchain_image}" \
  --arg zigzagSourceOverridesSha256 "${zigzag_overrides_sha256}" \
  --arg dockerfileSha256 "${dockerfile_sha256}" \
  --arg imageReference "${image}" \
  --arg imageId "${image_id}" \
  '{schemaVersion:1,platform:$platform,curioCommit:$curioCommit,lotusCommit:$lotusCommit,blstCommit:$blstCommit,rustFilProofsCommit:$rustFilProofsCommit,rustFilProofsSourceSha256:$rustFilProofsSourceSha256,rustFilProofsSourceRelative:$rustFilProofsSourceRelative,rustToolchainImage:$rustToolchainImage,zigzagSourceOverridesSha256:$zigzagSourceOverridesSha256,dockerfileSha256:$dockerfileSha256,imageReference:$imageReference,images:[{reference:$imageReference,id:$imageId}]}' \
  > "${temporary}"
mv -f -- "${temporary}" "${manifest}"
printf 'ZigZag microbench image=%s manifest=%s\n' "${image}" "${manifest}"
