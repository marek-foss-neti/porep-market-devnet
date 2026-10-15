#!/usr/bin/env bash
# Build variants affect only dedicated ZigZag images, never the standard SDR image.
zigzag_target_cpu="${DEVNET_ZIGZAG_TARGET_CPU:-default}"
zigzag_lto="${DEVNET_ZIGZAG_LTO:-off}"
zigzag_sha_asm="${DEVNET_ZIGZAG_SHA_ASM:-0}"
zigzag_gpu_backend="${DEVNET_ZIGZAG_GPU_BACKEND-cpu}"
zigzag_cuda_arch="${DEVNET_ZIGZAG_CUDA_ARCH-120}"
case "${zigzag_gpu_backend}" in cpu|cuda|opencl) ;; *) devnet_die "ZigZag GPU build must be cpu, cuda or opencl" ;; esac
case "${zigzag_cuda_arch}" in 75|80|86|89|90|100|120) ;; *) devnet_die "unsupported CUDA architecture for pinned toolkit" ;; esac
case "${zigzag_target_cpu}" in default|generic|native) ;; *) devnet_die "ZigZag target CPU must be default, generic or native" ;; esac
case "${zigzag_lto}" in off|thin|fat) ;; *) devnet_die "ZigZag LTO must be off, thin or fat" ;; esac
case "${zigzag_sha_asm}" in 0|1) ;; *) devnet_die "ZigZag SHA asm must be 0 or 1" ;; esac
zigzag_build_settings_sha256="$(printf '%s\n' "${zigzag_target_cpu}" "${zigzag_lto}" "${zigzag_sha_asm}" "${zigzag_gpu_backend}" "${zigzag_cuda_arch}" | shasum -a 256 | awk '{print $1}')"

zigzag_prepare_cuda_tools() {
  zigzag_cuda_tools_image=zigzag-cuda-tools:unbuilt
  zigzag_cuda_tools_id=""
  [[ "${zigzag_gpu_backend}" == cuda ]] || return 0
  local tools_hash
  tools_hash="$(shasum -a 256 "${DEVNET_ROOT}/docker/zigzag-cuda-tools.Dockerfile" | awk '{print $1}')"
  zigzag_cuda_tools_image="${DEVNET_IMAGE_NAMESPACE}/zigzag-cuda-tools:${tools_hash:0:16}"
  # The Dockerfile pins both CUDA and the trace package. Do not replace host drivers.
  docker buildx build --load --provenance=false --platform linux/amd64 --progress plain \
    --file "${DEVNET_ROOT}/docker/zigzag-cuda-tools.Dockerfile" --tag "${zigzag_cuda_tools_image}" "${DEVNET_ROOT}/docker"
  zigzag_cuda_tools_id="$(docker image inspect "${zigzag_cuda_tools_image}" --format '{{.Id}}')"
}
