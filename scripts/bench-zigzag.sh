#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

# Both entry points use this single comparison preset. Only sector geometry,
# native profile selection and cache namespaces differ.
sector_size="${1:-}"
[[ "$#" == 1 ]] || devnet_die "usage: bench-zigzag.sh 512mib|32gib"
case "${sector_size}" in
  512mib)
    baseline_profile=zigzag-512
    microbench_profile=zigzag-512
    sector_bytes=536870912
    parameter_dir="${BENCH_ZIGZAG_512_PARAMETER_DIR:-${DEVNET_ROOT}/.cache/zigzag-512-parameters}"
    ;;
  32gib)
    baseline_profile=zigzag-32g
    # Native 32 GiB already has the reference proof budget; no benchmark-only
    # Rust profile or different image is needed.
    microbench_profile=""
    sector_bytes=34359738368
    parameter_dir="${BENCH_ZIGZAG_32G_PARAMETER_DIR:-${DEVNET_ROOT}/.cache/zigzag-32g-parameters}"
    ;;
  *) devnet_die "unsupported ZigZag comparison sector: ${sector_size}; expected 512mib or 32gib" ;;
esac
[[ -z "${BENCH_PROOF_MICRO_LAYERS:-}" && -z "${POREP_PROOF_MICROBENCH_LAYERS:-}" ]] ||
  devnet_die "${baseline_profile} has fixed layers; unset BENCH_PROOF_MICRO_LAYERS and POREP_PROOF_MICROBENCH_LAYERS"
unsealed_bytes=$((sector_bytes / 128 * 127))

devnet_require_command jq
devnet_require_command docker
devnet_prepare_runtime

# Use the same selected image and manifest as bench-proof-micro.sh.
image_manifest="$(devnet_proof_microbench_manifest_for_backend zigzag)"
image="$(devnet_proof_microbench_image_for_backend zigzag)"
image_id="$(docker image inspect "${image}" --format '{{.Id}}')"
image_manifest_sha256="$(shasum -a 256 "${image_manifest}" | awk '{print $1}')"
rust_fil_proofs_source_sha256="$(jq -r '.rustFilProofsSourceSha256 // empty' "${image_manifest}")"
rust_fil_proofs_commit="$(jq -r '.rustFilProofsCommit // empty' "${image_manifest}")"
[[ "${rust_fil_proofs_commit}" =~ ^[0-9a-f]{40}$ ]] ||
  devnet_die "ZigZag image manifest has no valid rust-fil-proofs commit"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
baseline_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-${baseline_profile}-baseline"
devnet_require_safe_write_path "${baseline_dir}" directory
mkdir -p "${baseline_dir}"

# A prepared profile cache can be reused after the separate setup acceptance.
# Keep exact-profile parameters between full runs; prewarm still validates the cache.
if [[ "${parameter_dir}" == "${DEVNET_ROOT}/"* ]]; then
  devnet_require_safe_write_path "${parameter_dir}" directory
fi
parameter_cache_initial_state="empty before prewarm"
if [[ -n "$(find "${parameter_dir}" -maxdepth 1 -type f -name 'v28-zigzag-proof-of-replication-*.params' -print -quit 2>/dev/null)" ]]; then
  parameter_cache_initial_state="reused prepared cache"
fi
parent_dir="${BENCH_ZIGZAG_PARENT_CACHE_DIR:-${baseline_dir}/parent-cache}"
if [[ "${parent_dir}" == "${DEVNET_ROOT}/"* ]]; then
  devnet_require_safe_write_path "${parent_dir}" directory
fi
mkdir -p "${parameter_dir}" "${parent_dir}"

git -C "${DEVNET_ROOT}" rev-parse HEAD > "${baseline_dir}/devnet-head.txt"
printf '%s\n' "${rust_fil_proofs_commit}" > "${baseline_dir}/rust-fil-proofs-head.txt"
uname -a > "${baseline_dir}/uname.txt"
if command -v lscpu >/dev/null 2>&1; then lscpu > "${baseline_dir}/lscpu.txt"; fi
if command -v free >/dev/null 2>&1; then free -h > "${baseline_dir}/memory.txt"; fi
if command -v lsblk >/dev/null 2>&1; then lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT > "${baseline_dir}/disks.txt"; fi
df -Pk "${DEVNET_ROOT}" "${parameter_dir}" "${parent_dir}" > "${baseline_dir}/filesystems.txt"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -q > "${baseline_dir}/nvidia-smi.txt" 2>&1 || true
else
  printf 'nvidia-smi unavailable\n' > "${baseline_dir}/nvidia-smi.txt"
fi

reports=()
for repetition in 1; do
  printf '%s baseline repetition %s/1\n' "${baseline_profile}" "${repetition}" >&2
  # Keep the accepted comparison preset explicit in the runner's provenance.
  # BENCH_* overrides allow deliberate A/B runs, including disabling cache advice.
  output="$(
    BENCH_PROOF_MICRO_PROFILE="${microbench_profile}" \
    BENCH_ZIGZAG_PARENT_BUFFER_NODES="${BENCH_ZIGZAG_PARENT_BUFFER_NODES:-32768}" \
    BENCH_ZIGZAG_PARENT_CACHE_DONTNEED="${BENCH_ZIGZAG_PARENT_CACHE_DONTNEED:-1}" \
    BENCH_ZIGZAG_TREE_R_DONTNEED="${BENCH_ZIGZAG_TREE_R_DONTNEED:-1}" \
    BENCH_ZIGZAG_TREE_R_BUILDER="${BENCH_ZIGZAG_TREE_R_BUILDER-legacy}" \
    BENCH_ZIGZAG_ENCODE_PREHASH="${BENCH_ZIGZAG_ENCODE_PREHASH-0}" \
    BENCH_ZIGZAG_LAYER_PIPELINE="${BENCH_ZIGZAG_LAYER_PIPELINE-sequential}" \
    BENCH_ZIGZAG_TREE_R_THREADS="${BENCH_ZIGZAG_TREE_R_THREADS-auto}" \
    BENCH_ZIGZAG_SNAPSHOT_BUFFER_MIB="${BENCH_ZIGZAG_SNAPSHOT_BUFFER_MIB-64}" \
    BENCH_ZIGZAG_MALLOC_ARENA_MAX="${BENCH_ZIGZAG_MALLOC_ARENA_MAX-4}" \
    BENCH_ZIGZAG_PARAMETER_LOADER="${BENCH_ZIGZAG_PARAMETER_LOADER-compact}" \
    BENCH_ZIGZAG_QUERY_CACHE_BYTES="${BENCH_ZIGZAG_QUERY_CACHE_BYTES-0}" \
    BENCH_ZIGZAG_GROTH16_BATCH_SIZE="${BENCH_ZIGZAG_GROTH16_BATCH_SIZE:-1}" \
    BENCH_ZIGZAG_FULL_MEMORY_BYTES="${BENCH_ZIGZAG_FULL_MEMORY_BYTES:-53687091200}" \
    BENCH_PROOF_PARAMETERS_DIR="${parameter_dir}" \
    BENCH_ZIGZAG_PARENT_CACHE_DIR="${parent_dir}" \
    BENCH_RETAIN_ZIGZAG_WORK_ARTIFACTS=1 \
    BENCH_PRUNE_BUILDKIT_AFTER_BENCH=0 \
    POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
    bash "${DEVNET_ROOT}/scripts/bench-proof-micro.sh" zigzag "${sector_size}" full
  )"
  printf '%s\n' "${output}" | tee "${baseline_dir}/run-${repetition}.log"
  summary="$(printf '%s\n' "${output}" | sed -n 's/^proof microbenchmark: //p' | tail -1)"
  [[ -n "${summary}" && -f "${summary}" ]] || devnet_die "missing ${baseline_profile} run ${repetition} summary"
  report="$(dirname "${summary}")/report.json"
  [[ -f "${report}" ]] || devnet_die "missing ${baseline_profile} run ${repetition} report"
  jq -e \
    --arg commit "${rust_fil_proofs_commit}" \
    --arg sourceSha "${rust_fil_proofs_source_sha256}" \
    --arg manifest "${image_manifest}" \
    --arg manifestSha "${image_manifest_sha256}" \
    --arg image "${image}" \
    --arg imageId "${image_id}" \
    '.provenance.build.manifest.rust_fil_proofs_commit == $commit
      and .provenance.build.manifest.rust_fil_proofs_source_sha256 == $sourceSha
      and .provenance.build.image_manifest_path == $manifest
      and .provenance.build.image_manifest_sha256 == $manifestSha
      and .provenance.build.image.reference == $image
      and .provenance.build.image.id == $imageId' "${report}" >/dev/null ||
    devnet_die "${baseline_profile} run ${repetition} used a different ZigZag image or source"
  # Rust serializes Backend::ZigZag with serde kebab-case as "zig-zag";
  # the CLI selector is "zigzag", but that is not the report's backend value.
  jq -e --arg sector "${sector_size}" --argjson bytes "${sector_bytes}" \
    --argjson unsealed "${unsealed_bytes}" '
    def geometry:
      .backend == "zig-zag" and .sector_size_label == $sector and .sector_size_bytes == $bytes
      and .porep_layers == 11 and .porep_partitions == 10
      and .minimum_total_challenges == 176 and .challenges_per_layer_per_partition == 18;
    (.benchmark | geometry) and (.prewarm | geometry)
    and .benchmark.profile == .prewarm.profile
    and .benchmark.registered_seal_proof_id == .prewarm.registered_seal_proof_id
    and .prewarm.verifying_key_matches_params == true
    and .benchmark.verify_seal == true and .benchmark.raw_unseal_bytes_match == true
    and .benchmark.proof_len == 1920 and .benchmark.unsealed_bytes == $unsealed
  ' "${report}" >/dev/null || devnet_die "${baseline_profile} proof geometry or correctness validation failed"
  reports+=("${report}")
done

jq -s \
  --rawfile devnetHead "${baseline_dir}/devnet-head.txt" \
  --rawfile rustHead "${baseline_dir}/rust-fil-proofs-head.txt" \
  --arg profile "${baseline_profile}" \
  --arg initialCacheState "${parameter_cache_initial_state}" '
  {
    profile: $profile,
    command: ("just bench-" + $profile),
    devnet_head: ($devnetHead | rtrimstr("\n")),
    rust_fil_proofs_head: ($rustHead | rtrimstr("\n")),
    rust_fil_proofs_commit_source: "image manifest",
    cold_cache_policy: "first run may reuse an explicitly supplied profile cache; OS page cache state is not forced",
    completed_runs: length,
    runs: [to_entries[] | {
      repetition: (.key + 1),
      run_id: .value.provenance.run_id,
      report: (".runtime/runs/" + .value.provenance.run_id + "/report.json"),
      parameter_cache_state: (if .key == 0 then $initialCacheState else "reused" end),
      image_id: .value.provenance.build.image.id,
      profile: .value.benchmark.profile,
      sector_size: .value.benchmark.sector_size_label,
      sector_size_bytes: .value.benchmark.sector_size_bytes,
      porep_layers: .value.benchmark.porep_layers,
      porep_partitions: .value.benchmark.porep_partitions,
      total_challenge_instances: (.value.benchmark.porep_layers * .value.benchmark.porep_partitions * .value.benchmark.challenges_per_layer_per_partition),
      cpu_configuration: .value.cpu_configuration,
      memory_budget: .value.memory_budget,
      verified: .value.benchmark.verify_seal,
      byte_match: .value.benchmark.raw_unseal_bytes_match,
      proof_bytes: .value.benchmark.proof_len,
      outer_wall_ms: .value.provenance.invocation.outer_wall_ms,
      cgroup_memory_peak_bytes: .value.derived.cgroup_memory_peak_bytes,
      sampled_disk_allocated_peak_bytes: .value.derived.sampled_disk_allocated_peak_bytes,
      parameter_prewarm_wall_ms: .value.prewarm.wall_ms
    }]
  }
' "${reports[@]}" > "${baseline_dir}/baseline.json"
jq -e '.completed_runs == 1 and all(.runs[]; .verified and .byte_match and .proof_bytes == 1920 and .total_challenge_instances == 1980)' \
  "${baseline_dir}/baseline.json" >/dev/null || devnet_die "${baseline_profile} baseline validation failed"
df -Pk "${DEVNET_ROOT}" "${parameter_dir}" "${parent_dir}" > "${baseline_dir}/filesystems-after.txt"
printf '%s baseline: %s\n' "${baseline_profile}" "${baseline_dir}/baseline.json"
