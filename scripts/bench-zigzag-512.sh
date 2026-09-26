#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

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
baseline_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-zigzag-512-baseline"
devnet_require_safe_write_path "${baseline_dir}" directory
mkdir -p "${baseline_dir}"

# A prepared profile cache can be reused after the separate setup acceptance.
# With no override the original fresh-cache behaviour remains available.
parameter_dir="${BENCH_ZIGZAG_512_PARAMETER_DIR:-${baseline_dir}/proof-parameters}"
if [[ "${parameter_dir}" == "${DEVNET_ROOT}/"* ]]; then
  devnet_require_safe_write_path "${parameter_dir}" directory
fi
parameter_cache_initial_state="empty before prewarm"
if [[ -n "$(find "${parameter_dir}" -maxdepth 1 -type f -name 'v28-zigzag-proof-of-replication-*.params' -print -quit 2>/dev/null)" ]]; then
  parameter_cache_initial_state="reused prepared cache"
fi
parent_dir="${baseline_dir}/parent-cache"
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
for repetition in 1 2 3; do
  printf 'zigzag-512 baseline repetition %s/3\n' "${repetition}" >&2
  output="$(
    BENCH_PROOF_MICRO_PROFILE=zigzag-512 \
    BENCH_PROOF_PARAMETERS_DIR="${parameter_dir}" \
    BENCH_ZIGZAG_PARENT_CACHE_DIR="${parent_dir}" \
    BENCH_RETAIN_ZIGZAG_WORK_ARTIFACTS=1 \
    BENCH_PRUNE_BUILDKIT_AFTER_BENCH=0 \
    POREP_PROOF_MICROBENCH_ALLOW_LARGE_SECTORS=1 \
    bash "${DEVNET_ROOT}/scripts/bench-proof-micro.sh" zigzag 512mib full
  )"
  printf '%s\n' "${output}" | tee "${baseline_dir}/run-${repetition}.log"
  summary="$(printf '%s\n' "${output}" | sed -n 's/^proof microbenchmark: //p' | tail -1)"
  [[ -n "${summary}" && -f "${summary}" ]] || devnet_die "missing zigzag-512 run ${repetition} summary"
  report="$(dirname "${summary}")/report.json"
  [[ -f "${report}" ]] || devnet_die "missing zigzag-512 run ${repetition} report"
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
    devnet_die "zigzag-512 run ${repetition} used a different ZigZag image or source"
  reports+=("${report}")
done

jq -s \
  --rawfile devnetHead "${baseline_dir}/devnet-head.txt" \
  --rawfile rustHead "${baseline_dir}/rust-fil-proofs-head.txt" \
  --arg initialCacheState "${parameter_cache_initial_state}" '
  {
    profile: "zigzag-512",
    command: "just bench-zigzag-512",
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
jq -e '.completed_runs == 3 and all(.runs[]; .verified and .byte_match and .proof_bytes == 1920 and .profile.total_challenge_instances == 1980)' \
  "${baseline_dir}/baseline.json" >/dev/null || devnet_die "zigzag-512 baseline validation failed"
df -Pk "${DEVNET_ROOT}" "${parameter_dir}" "${parent_dir}" > "${baseline_dir}/filesystems-after.txt"
printf 'zigzag-512 baseline: %s\n' "${baseline_dir}/baseline.json"
