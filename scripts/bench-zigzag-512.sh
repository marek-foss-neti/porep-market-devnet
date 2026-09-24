#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command jq
devnet_require_command docker
devnet_prepare_runtime

# The benchmark runs the built image, not an optional sibling Git checkout.
image_manifest="${DEVNET_BUILD_DIR}/images.json"
[[ -f "${image_manifest}" && ! -L "${image_manifest}" ]] ||
  devnet_die "image manifest is missing; run just build first"
rust_fil_proofs_commit="$(jq -r '.rustFilProofsCommit // empty' "${image_manifest}")"
[[ "${rust_fil_proofs_commit}" =~ ^[0-9a-f]{40}$ ]] ||
  devnet_die "image manifest has no valid rust-fil-proofs commit; run just build"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
baseline_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-zigzag-512-baseline"
devnet_require_safe_write_path "${baseline_dir}" directory
mkdir -p "${baseline_dir}"

# A fresh parameter directory makes preparation visible in the first run. All
# three measured runs use the same generated 512 MiB / 11 / 10 / 18 parameters.
parameter_dir="${baseline_dir}/proof-parameters"
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
  jq -e --arg commit "${rust_fil_proofs_commit}" \
    '.provenance.build.manifest.rust_fil_proofs_commit == $commit' "${report}" >/dev/null ||
    devnet_die "zigzag-512 run ${repetition} used a different rust-fil-proofs build"
  reports+=("${report}")
done

jq -s \
  --rawfile devnetHead "${baseline_dir}/devnet-head.txt" \
  --rawfile rustHead "${baseline_dir}/rust-fil-proofs-head.txt" '
  {
    profile: "zigzag-512",
    command: "just bench-zigzag-512",
    devnet_head: ($devnetHead | rtrimstr("\n")),
    rust_fil_proofs_head: ($rustHead | rtrimstr("\n")),
    rust_fil_proofs_commit_source: "image manifest",
    cold_cache_policy: "first run starts with an empty profile-specific parameter directory; OS page cache state is not forced",
    completed_runs: length,
    runs: [to_entries[] | {
      repetition: (.key + 1),
      run_id: .value.provenance.run_id,
      report: (".runtime/runs/" + .value.provenance.run_id + "/report.json"),
      parameter_cache_state: (if .key == 0 then "empty before prewarm" else "reused" end),
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
