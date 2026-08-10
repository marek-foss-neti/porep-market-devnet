#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"

if [[ "${DEVNET_BUILD_TIMEOUT_ACTIVE:-0}" != 1 ]]; then
  export DEVNET_BUILD_TIMEOUT_ACTIVE=1
  exec node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" \
    --timeout-ms "${DEVNET_BUILD_TIMEOUT_MS}" \
    -- bash "${DEVNET_ROOT}/scripts/devnet-build.sh"
fi

cd "${DEVNET_ROOT}"
devnet_require_command docker
devnet_require_command node
devnet_require_command npm
devnet_require_command shasum

mkdir -p "${DEVNET_BUILD_DIR}" "${DEVNET_LOG_DIR}"
build_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
build_started_epoch="$(date '+%s')"
build_log_relative=".runtime/devnet/logs/build-${build_started_epoch}.log"
build_log="${DEVNET_ROOT}/${build_log_relative}"
exec > >(devnet_sanitize_build_log | tee -a "${build_log}") 2>&1

build_succeeded=0
on_exit() {
  local exit_code=$?
  if ((build_succeeded == 0)); then
    printf 'build failed with exit %d; retained log: %s\n' \
      "${exit_code}" "${build_log_relative}" >&2
  fi
}
trap on_exit EXIT

printf 'build start=%s log=%s\n' "${build_started_at}" "${build_log_relative}"

docker_version="$(docker version --format 'client={{.Client.Version}} server={{.Server.Version}}')"
docker_architecture_raw="$(docker info --format '{{.Architecture}}')"
docker_architecture="$(devnet_normalize_architecture "${docker_architecture_raw}")"
docker_memory_bytes="$(docker info --format '{{.MemTotal}}')"
docker_cpu_count="$(docker info --format '{{.NCPU}}')"
host_free_bytes="$(df -Pk "${DEVNET_ROOT}" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')"
minimum_free_bytes=$((14 * 1024 * 1024 * 1024))
minimum_memory_bytes=$((7 * 1024 * 1024 * 1024))

[[ "${docker_memory_bytes}" =~ ^[0-9]+$ ]] || devnet_die "Docker reported invalid memory capacity"
[[ "${host_free_bytes}" =~ ^[0-9]+$ ]] || devnet_die "host filesystem reported invalid free capacity"
((docker_memory_bytes >= minimum_memory_bytes)) ||
  devnet_die "Docker memory ${docker_memory_bytes} is below required ${minimum_memory_bytes} bytes"
((host_free_bytes >= minimum_free_bytes)) ||
  devnet_die "host free space ${host_free_bytes} is below required ${minimum_free_bytes} bytes"

buildx_state="$(docker buildx inspect)"
grep -Eq "linux/${docker_architecture}([,[:space:]]|$)" <<<"${buildx_state}" ||
  devnet_die "active BuildKit builder does not support linux/${docker_architecture}"

printf 'resource docker="%s" platform=linux/%s cpus=%s memory_bytes=%s host_free_bytes=%s\n' \
  "${docker_version}" "${docker_architecture}" "${docker_cpu_count}" \
  "${docker_memory_bytes}" "${host_free_bytes}"

runtime_lock_output="$(npm --prefix tools run cli -- runtime lock verify)"
source_verify_output="$(npm --prefix tools run cli -- sources verify)"

lotus_devnet_image_reference=""
yugabyte_image_reference=""
go_builder_image_reference=""
rust_toolchain_image_reference=""
ubuntu_runtime_image_reference=""
node_runtime_image_reference=""
foundry_image_reference=""
go_car_tool_commit=""
piece_server_tool_commit=""
storetheindex_tool_commit=""
go_ethereum_tool_commit=""
blst_tool_commit=""
blst_tool_managed_source=""
while IFS=$'\t' read -r record_kind record_name field_three field_four field_five; do
  case "${record_kind}" in
    image)
      case "${record_name}" in
        lotus_devnet) lotus_devnet_image_reference="${field_three}" ;;
        yugabyte) yugabyte_image_reference="${field_three}" ;;
        go_builder) go_builder_image_reference="${field_three}" ;;
        rust_toolchain) rust_toolchain_image_reference="${field_three}" ;;
        ubuntu_runtime) ubuntu_runtime_image_reference="${field_three}" ;;
        node_runtime) node_runtime_image_reference="${field_three}" ;;
        foundry) foundry_image_reference="${field_three}" ;;
      esac
      ;;
    tool)
      case "${record_name}" in
        go_car) go_car_tool_commit="${field_four:-}" ;;
        piece_server) piece_server_tool_commit="${field_four:-}" ;;
        storetheindex) storetheindex_tool_commit="${field_four:-}" ;;
        go_ethereum) go_ethereum_tool_commit="${field_four:-}" ;;
        blst)
          blst_tool_commit="${field_four:-}"
          if [[ "${field_five:-}" == managed-source=* ]]; then
            blst_tool_managed_source="${field_five#managed-source=}"
          fi
          ;;
      esac
      ;;
  esac
done <<<"${runtime_lock_output}"

curio_commit=""
lotus_commit=""
blst_commit=""
rust_fil_proofs_commit=""
curio_source_reported=""
lotus_source_reported=""
blst_source_reported=""
rust_fil_proofs_source_reported=""
curio_state=""
lotus_state=""
blst_state=""
rust_fil_proofs_state=""
while IFS=$'\t' read -r source_name source_path expected_commit actual_commit detached_state clean_state _; do
  case "${source_name}" in
    blst)
      blst_commit="${expected_commit}"
      blst_source_reported="${source_path}"
      blst_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
    curio)
      curio_commit="${expected_commit}"
      curio_source_reported="${source_path}"
      curio_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
    lotus)
      lotus_commit="${expected_commit}"
      lotus_source_reported="${source_path}"
      lotus_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
    rust_fil_proofs)
      rust_fil_proofs_commit="${expected_commit}"
      rust_fil_proofs_source_reported="${source_path}"
      rust_fil_proofs_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
  esac
done <<<"${source_verify_output}"

[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report Curio commit"
[[ "${lotus_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report Lotus commit"
[[ "${blst_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report BLST commit"
[[ "${rust_fil_proofs_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report rust-fil-proofs commit"
[[ "${curio_state}" == "${curio_commit}:detached:clean" ]] ||
  devnet_die "Curio managed source is not exact, detached, and clean"
[[ "${lotus_state}" == "${lotus_commit}:detached:clean" ]] ||
  devnet_die "Lotus managed source is not exact, detached, and clean"
[[ "${blst_state}" == "${blst_commit}:detached:clean" ]] ||
  devnet_die "BLST managed source is not exact, detached, and clean"
[[ "${rust_fil_proofs_state}" == "${rust_fil_proofs_commit}:detached:clean" ]] ||
  devnet_die "rust-fil-proofs managed source is not exact, detached, and clean"
[[ "${blst_tool_managed_source}" == blst ]] ||
  devnet_die "typed runtime lock did not bind BLST to the blst managed source"
[[ "${blst_tool_commit}" == "${blst_commit}" ]] ||
  devnet_die "typed BLST tool commit does not match the verified managed source"

curio_source="$(devnet_curio_source_path "${curio_commit}")"
lotus_source="$(devnet_lotus_source_path "${lotus_commit}")"
blst_source="$(devnet_blst_source_path "${blst_commit}")"
rust_fil_proofs_source="$(devnet_rust_fil_proofs_source_path "${rust_fil_proofs_commit}")"
curio_source_relative=".cache/sources/curio/${curio_commit}"
lotus_source_relative=".cache/sources/lotus/${lotus_commit}"
blst_source_relative=".cache/sources/blst/${blst_commit}"
rust_fil_proofs_source_relative=".cache/sources/rust_fil_proofs/${rust_fil_proofs_commit}"
[[ "${curio_source_reported}" == "${curio_source}" ]] ||
  devnet_die "typed Curio source path does not match the managed source path"
[[ "${lotus_source_reported}" == "${lotus_source}" ]] ||
  devnet_die "typed Lotus source path does not match the managed source path"
[[ "${blst_source_reported}" == "${blst_source}" ]] ||
  devnet_die "typed BLST source path does not match the managed source path"
[[ "${rust_fil_proofs_source_reported}" == "${rust_fil_proofs_source}" ]] ||
  devnet_die "typed rust-fil-proofs source path does not match the managed source path"
[[ -d "${curio_source}" && ! -L "${curio_source}" ]] ||
  devnet_die "managed Curio source path is missing or symbolic"
[[ -d "${lotus_source}" && ! -L "${lotus_source}" ]] ||
  devnet_die "managed Lotus source path is missing or symbolic"
[[ -d "${blst_source}" && ! -L "${blst_source}" ]] ||
  devnet_die "managed BLST source path is missing or symbolic"
[[ -d "${rust_fil_proofs_source}" && ! -L "${rust_fil_proofs_source}" ]] ||
  devnet_die "managed rust-fil-proofs source path is missing or symbolic"
for blst_input in build.sh build src bindings LICENSE; do
  [[ -e "${blst_source}/${blst_input}" && ! -L "${blst_source}/${blst_input}" ]] ||
    devnet_die "managed BLST source is missing required tracked input ${blst_input}"
done

for rust_fil_proofs_input in \
  Cargo.toml Cargo.lock parameters.json srs-inner-product.json fil-proofs-param \
  fil-proofs-tooling filecoin-hashers filecoin-proofs fr32 sha2raw \
  storage-proofs-core storage-proofs-porep storage-proofs-post \
  storage-proofs-update; do
  [[ -e "${rust_fil_proofs_source}/${rust_fil_proofs_input}" && ! -L "${rust_fil_proofs_source}/${rust_fil_proofs_input}" ]] ||
    devnet_die "ZigZag rust-fil-proofs source is missing required input ${rust_fil_proofs_input}"
done
grep -Fq 'pub fn zigzag_prove_from_cache' \
  "${rust_fil_proofs_source}/filecoin-proofs/src/api/zigzag.rs" ||
  devnet_die "ZigZag rust-fil-proofs source does not expose zigzag_prove_from_cache"
grep -Fq 'pub fn zigzag_pre_commit_phase1_with_replica_id' \
  "${rust_fil_proofs_source}/filecoin-proofs/src/api/zigzag.rs" ||
  devnet_die "ZigZag rust-fil-proofs source does not expose zigzag_pre_commit_phase1_with_replica_id"
zigzag_source_overrides_sha256="$(devnet_zigzag_source_overrides_sha256)"
rust_fil_proofs_zigzag_api_sha256="$(devnet_rust_fil_proofs_zigzag_api_sha256 "${rust_fil_proofs_commit}")"

required_images=(
  "lotus_devnet ${lotus_devnet_image_reference}"
  "yugabyte ${yugabyte_image_reference}"
  "go_builder ${go_builder_image_reference}"
  "rust_toolchain ${rust_toolchain_image_reference}"
  "ubuntu_runtime ${ubuntu_runtime_image_reference}"
  "node_runtime ${node_runtime_image_reference}"
  "foundry ${foundry_image_reference}"
)
for required_image_record in "${required_images[@]}"; do
  read -r required_image image_reference <<<"${required_image_record}"
  [[ "${image_reference}" =~ @sha256:[0-9a-f]{64}$ ]] ||
    devnet_die "typed runtime lock did not report immutable ${required_image} image"
done

required_tools=(
  "go_car ${go_car_tool_commit}"
  "piece_server ${piece_server_tool_commit}"
  "storetheindex ${storetheindex_tool_commit}"
  "go_ethereum ${go_ethereum_tool_commit}"
  "blst ${blst_tool_commit}"
)
for required_tool_record in "${required_tools[@]}"; do
  read -r required_tool tool_commit <<<"${required_tool_record}"
  [[ "${tool_commit}" =~ ^[0-9a-f]{40}$ ]] ||
    devnet_die "typed runtime lock did not report exact ${required_tool} commit"
done

dockerfile_relative="docker/curio-all-in-one.Dockerfile"
dockerfile="${DEVNET_ROOT}/${dockerfile_relative}"
dockerfile_sha256="$(devnet_docker_surface_sha256)"
curio_short_commit="${curio_commit:0:12}"
platform="linux/${docker_architecture}"

base_image="porep-market-curio-devnet/curio-all-in-one:${curio_short_commit}"
lotus_image="porep-market-curio-devnet/lotus:${curio_short_commit}"
contracts_bootstrap_image="porep-market-curio-devnet/contracts-bootstrap:${curio_short_commit}"
lotus_miner_image="porep-market-curio-devnet/lotus-miner:${curio_short_commit}"
curio_image="porep-market-curio-devnet/curio:${curio_short_commit}"
piece_server_image="porep-market-curio-devnet/piece-server:${curio_short_commit}"
indexer_image="porep-market-curio-devnet/indexer:${curio_short_commit}"

manifest_relative=".runtime/devnet/build/images.json"
manifest_path="${DEVNET_ROOT}/${manifest_relative}"
if [[ -f "${manifest_path}" && ! -L "${manifest_path}" ]] &&
  (devnet_write_compose_env >/dev/null 2>&1); then
  printf 'reusing validated local images manifest=%s\n' "${manifest_relative}"
  build_succeeded=1
  exit 0
fi

manifest_history_directory="${DEVNET_BUILD_DIR}/history"
archive_name="images.before-${build_started_epoch}-$$.json"
archived_manifest="$(
  devnet_archive_active_manifest \
    "${manifest_path}" "${manifest_history_directory}" "${archive_name}"
)"
if [[ -n "${archived_manifest}" ]]; then
  printf 'archived previous manifest=%s\n' "${archived_manifest#"${DEVNET_ROOT}/"}"
fi

printf 'building %s from verified context %s\n' \
  "${base_image}" "${curio_source_relative}"
docker buildx build \
  --load \
  --provenance=false \
  --platform "${platform}" \
  --progress plain \
  --file "${dockerfile_relative}" \
  --target curio-all-in-one \
  --build-context "blst-source=${blst_source_relative}" \
  --build-context "harness-overlay=." \
  --build-context "lotus-source=${lotus_source_relative}" \
  --build-context "rust-fil-proofs=${rust_fil_proofs_source_relative}" \
  --build-arg "LOTUS_TEST_IMAGE=${lotus_devnet_image_reference}" \
  --build-arg "GO_BUILDER_IMAGE=${go_builder_image_reference}" \
  --build-arg "RUST_TOOLCHAIN_IMAGE=${rust_toolchain_image_reference}" \
  --build-arg "UBUNTU_RUNTIME_IMAGE=${ubuntu_runtime_image_reference}" \
  --build-arg "NODE_RUNTIME_IMAGE=${node_runtime_image_reference}" \
  --build-arg "FOUNDRY_IMAGE=${foundry_image_reference}" \
  --build-arg "CURIO_COMMIT=${curio_commit}" \
  --build-arg "CURIO_FFI_COMMIT=fbe802089480458d730cbce8a3ca83dcd84a4cd1" \
  --build-arg "CURIO_TAGS=cunative debug nosupraseal" \
  --build-arg "GO_CAR_COMMIT=${go_car_tool_commit}" \
  --build-arg "PIECE_SERVER_COMMIT=${piece_server_tool_commit}" \
  --build-arg "STORETHEINDEX_COMMIT=${storetheindex_tool_commit}" \
  --build-arg "GO_ETHEREUM_COMMIT=${go_ethereum_tool_commit}" \
  --build-arg "LOTUS_COMMIT=${lotus_commit}" \
  --build-arg "BLST_COMMIT=${blst_commit}" \
  --build-arg "DOCKERFILE_SHA256=${dockerfile_sha256}" \
  --build-arg "RUST_FIL_PROOFS_COMMIT=${rust_fil_proofs_commit}" \
  --build-arg "ZIGZAG_SOURCE_OVERRIDES_SHA256=${zigzag_source_overrides_sha256}" \
  --build-arg "ZIGZAG_RUST_FIL_PROOFS_API_SHA256=${rust_fil_proofs_zigzag_api_sha256}" \
  --tag "${base_image}" \
  "${curio_source_relative}"

derived_builds=(
  "docker/lotus/Dockerfile|docker/lotus|${lotus_image}"
  "docker/contracts-bootstrap/Dockerfile|docker/contracts-bootstrap|${contracts_bootstrap_image}"
  "docker/lotus-miner/Dockerfile|docker/lotus-miner|${lotus_miner_image}"
  "docker/curio/Dockerfile|docker/curio|${curio_image}"
  "docker/piece-server/Dockerfile|docker/piece-server|${piece_server_image}"
  "docker/indexer/Dockerfile|docker/indexer|${indexer_image}"
)

for derived_build in "${derived_builds[@]}"; do
  IFS='|' read -r relative_dockerfile relative_context derived_image <<<"${derived_build}"
  printf 'building %s from verified upstream service context %s\n' \
    "${derived_image}" "${relative_context}"
  docker buildx build \
    --load \
    --provenance=false \
    --platform "${platform}" \
    --progress plain \
    --file "${relative_dockerfile}" \
    --build-context "harness-overlay=." \
    --build-arg "CURIO_TEST_IMAGE=${base_image}" \
    --build-arg "BUILD_VERSION=${curio_short_commit}" \
    --tag "${derived_image}" \
    "${curio_source_relative}/${relative_context}"
done

images=(
  "${base_image}"
  "${lotus_image}"
  "${contracts_bootstrap_image}"
  "${lotus_miner_image}"
  "${curio_image}"
  "${piece_server_image}"
  "${indexer_image}"
)
inspect_evidence="${DEVNET_BUILD_DIR}/images.inspect.${build_started_epoch}.ndjson"
: > "${inspect_evidence}"
for image in "${images[@]}"; do
  docker image inspect "${image}" --format '{{json .}}' >> "${inspect_evidence}"
done

build_finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
build_finished_epoch="$(date '+%s')"
build_duration_seconds=$((build_finished_epoch - build_started_epoch))
manifest_temporary="$(mktemp "${DEVNET_BUILD_DIR}/images.json.XXXXXX")"

node - "${inspect_evidence}" "${manifest_temporary}" \
  "${build_started_at}" "${build_finished_at}" "${build_duration_seconds}" \
  "${platform}" "${curio_commit}" "${lotus_commit}" "${blst_commit}" "${dockerfile_sha256}" \
  "${rust_fil_proofs_commit}" "${zigzag_source_overrides_sha256}" "${rust_fil_proofs_zigzag_api_sha256}" \
  "${curio_short_commit}" "${DEVNET_IMAGE_NAMESPACE}" <<'NODE'
const fs = require("node:fs");

const [
  inspectPath,
  outputPath,
  startedAt,
  finishedAt,
  durationText,
  platform,
  curioCommit,
  lotusCommit,
  blstCommit,
  dockerfileSha256,
  rustFilProofsCommit,
  zigzagSourceOverridesSha256,
  zigzagRustFilProofsApiSha256,
  tag,
  namespace,
] = process.argv.slice(2);
const expectedLabels = {
  "io.porep-market.curio.commit": curioCommit,
  "io.porep-market.lotus.commit": lotusCommit,
  "io.porep-market.blst.commit": blstCommit,
  "io.porep-market.dockerfile.sha256": dockerfileSha256,
  "io.porep-market.zigzag.rust-fil-proofs.commit": rustFilProofsCommit,
  "io.porep-market.zigzag.source-overrides.sha256": zigzagSourceOverridesSha256,
  "io.porep-market.zigzag.rust-fil-proofs.api.sha256": zigzagRustFilProofsApiSha256,
};
const inspections = fs.readFileSync(inspectPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (inspections.length !== 7) {
  throw new Error(`expected 7 built image inspections, found ${inspections.length}`);
}
const images = inspections.map((inspection) => {
  const labels = inspection.Config?.Labels ?? {};
  const volumes = inspection.Config?.Volumes ?? {};
  if (Object.keys(volumes).length !== 0) {
    throw new Error(
      `${inspection.RepoTags?.[0] ?? inspection.Id} declares unexpected image volumes`,
    );
  }
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (labels[name] !== value) {
      throw new Error(`${inspection.RepoTags?.[0] ?? inspection.Id} has invalid ${name}`);
    }
  }
  if (`${inspection.Os}/${inspection.Architecture}` !== platform) {
    throw new Error(`${inspection.RepoTags?.[0] ?? inspection.Id} has invalid platform`);
  }
  const reference = inspection.RepoTags?.find((candidate) =>
    candidate.startsWith(`${namespace}/`) && candidate.endsWith(`:${tag}`));
  if (reference === undefined) {
    throw new Error(`${inspection.Id} is missing the exact namespaced tag`);
  }
  return {
    reference,
    id: inspection.Id,
    os: inspection.Os,
    architecture: inspection.Architecture,
    labels: expectedLabels,
  };
});
const manifest = {
  schemaVersion: 1,
  namespace,
  tag,
  platform,
  curioCommit,
  lotusCommit,
  blstCommit: blstCommit,
  rustFilProofsCommit,
  dockerfileSha256,
  zigzagSourceOverridesSha256,
  zigzagRustFilProofsApiSha256,
  startedAt,
  finishedAt,
  durationSeconds: Number(durationText),
  images,
};
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
NODE

devnet_publish_manifest "${manifest_temporary}" "${manifest_path}"
printf 'build complete finish=%s duration_seconds=%s manifest=%s\n' \
  "${build_finished_at}" "${build_duration_seconds}" "${manifest_relative}"
node -e '
  const manifest = require(process.argv[1]);
  for (const image of manifest.images) {
    console.log(`${image.reference}\t${image.id}\t${image.os}/${image.architecture}`);
  }
' "${manifest_path}"

build_succeeded=1
