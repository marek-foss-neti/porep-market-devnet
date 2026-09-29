#!/usr/bin/env bash
set -euo pipefail

source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"
cd "${DEVNET_ROOT}"
devnet_require_command docker
devnet_require_command jq
devnet_require_command npm
devnet_require_command grep
devnet_require_command shasum

source_output="$(npm --prefix tools run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
blst_commit="$(awk -F '\t' '$1 == "blst" {print $3}' <<<"${source_output}")"
locked_proofs_commit="$(awk -F '\t' '$1 == "rust_fil_proofs" {print $3}' <<<"${source_output}")"
[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ && "${blst_commit}" =~ ^[0-9a-f]{40}$ && "${locked_proofs_commit}" =~ ^[0-9a-f]{40}$ ]] ||
  devnet_die "ZigZag Curio source verification returned invalid commits"

proofs_source="$(devnet_rust_fil_proofs_source_path "${locked_proofs_commit}")"
[[ "${proofs_source}" == "${DEVNET_ROOT}/"* && ! -L "${proofs_source}" ]] ||
  devnet_die "ZigZag Curio source must be a real directory inside the build context"
proofs_commit="$(git -C "${proofs_source}" rev-parse HEAD)"
[[ "${proofs_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "invalid ZigZag source HEAD"
grep -q 'pub fn zigzag_commit_phase1_from_cache' "${proofs_source}/filecoin-proofs/src/api/zigzag.rs" ||
  devnet_die "ZigZag Curio source lacks the stage 3 C1/C2 API"
if [[ -z "${DEVNET_RUST_FIL_PROOFS_SOURCE:-}" ]]; then
  [[ "${proofs_commit}" == "${locked_proofs_commit}" ]] ||
    devnet_die "managed ZigZag source differs from the lock"
fi

curio_source_relative=".cache/sources/curio/${curio_commit}"
blst_source_relative=".cache/sources/blst/${blst_commit}"
proofs_source_relative="${proofs_source#"${DEVNET_ROOT}/"}"
[[ -d "${curio_source_relative}" && -d "${blst_source_relative}" ]] ||
  devnet_die "managed Curio or BLST source is missing"

base_image="${DEVNET_IMAGE_NAMESPACE}/curio:${curio_commit:0:12}"
base_manifest="${DEVNET_BUILD_DIR}/images.json"
[[ -f "${base_manifest}" && ! -L "${base_manifest}" ]] || devnet_die "standard image manifest is missing"
base_id="$(jq -r --arg ref "${base_image}" '.images[] | select(.reference == $ref) | .id' "${base_manifest}")"
[[ "${base_id}" == sha256:* && "$(docker image inspect "${base_image}" --format '{{.Id}}')" == "${base_id}" ]] ||
  devnet_die "standard Curio base image does not match its manifest"

toolchain_image="${DEVNET_ZIGZAG_RUST_TOOLCHAIN_IMAGE:-docker.io/library/rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62}"
[[ "${toolchain_image}" =~ @sha256:[0-9a-f]{64}$ ]] || devnet_die "ZigZag toolchain must be pinned"
proofs_sha="$(devnet_rust_fil_proofs_content_sha256 "${proofs_source}")"
overrides_sha="$(devnet_zigzag_curio_overrides_sha256)"
dockerfile_sha="$(shasum -a 256 docker/zigzag-curio.Dockerfile | awk '{print $1}')"
platform="linux/$(devnet_normalize_architecture "$(docker info --format '{{.Architecture}}')")"
image="${DEVNET_IMAGE_NAMESPACE}/curio-zigzag:${proofs_sha:0:12}-${overrides_sha:0:12}"

docker buildx build --load --provenance=false --progress plain \
  --platform "${platform}" --file docker/zigzag-curio.Dockerfile \
  --target zigzag-curio \
  --build-context "blst-source=${blst_source_relative}" \
  --build-context "curio-source=${curio_source_relative}" \
  --build-context "rust-fil-proofs=${proofs_source_relative}" \
  --build-context "harness-overlay=." \
  --build-arg "ZIGZAG_RUST_TOOLCHAIN_IMAGE=${toolchain_image}" \
  --build-arg "BASE_CURIO_IMAGE=${base_image}" \
  --build-arg "CURIO_COMMIT=${curio_commit}" \
  --build-arg "CURIO_FFI_COMMIT=fbe802089480458d730cbce8a3ca83dcd84a4cd1" \
  --build-arg "RUST_FIL_PROOFS_COMMIT=${proofs_commit}" \
  --build-arg "RUST_FIL_PROOFS_SOURCE_SHA256=${proofs_sha}" \
  --build-arg "ZIGZAG_SOURCE_OVERRIDES_SHA256=${overrides_sha}" \
  --build-arg "ZIGZAG_DOCKERFILE_SHA256=${dockerfile_sha}" \
  --tag "${image}" "${curio_source_relative}"

image_id="$(docker image inspect "${image}" --format '{{.Id}}')"
for record in \
  "io.porep-market.zigzag.stage3|1" \
  "io.porep-market.zigzag.rust-fil-proofs.source-sha256|${proofs_sha}" \
  "io.porep-market.zigzag.source-overrides.sha256|${overrides_sha}" \
  "io.porep-market.zigzag.dockerfile.sha256|${dockerfile_sha}"; do
  IFS='|' read -r key expected <<<"${record}"
  [[ "$(docker image inspect "${image}" --format "{{index .Config.Labels \"${key}\"}}")" == "${expected}" ]] ||
    devnet_die "ZigZag Curio image label mismatch: ${key}"
done

mkdir -p "${DEVNET_BUILD_DIR}"
manifest="${DEVNET_BUILD_DIR}/zigzag-curio-images.json"
temporary="$(mktemp "${manifest}.XXXXXX")"
jq -n \
  --arg platform "${platform}" \
  --arg curioCommit "${curio_commit}" --arg rustFilProofsCommit "${proofs_commit}" \
  --arg rustFilProofsSourceRelative "${proofs_source_relative}" \
  --arg rustFilProofsSourceSha256 "${proofs_sha}" --arg sourceOverridesSha256 "${overrides_sha}" \
  --arg dockerfileSha256 "${dockerfile_sha}" --arg toolchainImage "${toolchain_image}" \
  --arg baseImage "${base_image}" --arg baseImageId "${base_id}" \
  --arg imageReference "${image}" --arg imageId "${image_id}" \
  '{schemaVersion:1,platform:$platform,curioCommit:$curioCommit,rustFilProofsCommit:$rustFilProofsCommit,rustFilProofsSourceRelative:$rustFilProofsSourceRelative,rustFilProofsSourceSha256:$rustFilProofsSourceSha256,sourceOverridesSha256:$sourceOverridesSha256,dockerfileSha256:$dockerfileSha256,toolchainImage:$toolchainImage,baseImage:$baseImage,baseImageId:$baseImageId,imageReference:$imageReference,imageId:$imageId}' \
  > "${temporary}"
mv -- "${temporary}" "${manifest}"
printf 'ZigZag Curio image=%s manifest=%s\n' "${image}" "${manifest}"
