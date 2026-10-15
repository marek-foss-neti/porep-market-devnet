ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE=docker.io/library/rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62
ARG ZIGZAG_GPU_BACKEND=cpu
ARG ZIGZAG_CUDA_TOOLS_IMAGE=zigzag-cuda-tools:unbuilt
FROM ${ZIGZAG_CUDA_TOOLS_IMAGE} AS cuda-tools

FROM ${ZIGZAG_RUST_TOOLCHAIN_IMAGE} AS builder-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      clang \
      git \
      libhwloc-dev \
      ocl-icd-opencl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

FROM builder-base AS builder-cpu
FROM builder-base AS builder-opencl
FROM builder-base AS builder-cuda
COPY --from=cuda-tools /usr/local/cuda-12.8 /usr/local/cuda-12.8
ENV PATH=/usr/local/cuda-12.8/bin:${PATH} \
    LIBRARY_PATH=/usr/local/cuda-12.8/lib64/stubs \
    CUDA_PATH=/usr/local/cuda-12.8

FROM builder-${ZIGZAG_GPU_BACKEND} AS zigzag-builder
WORKDIR /opt/curio
COPY --from=curio-source / /opt/curio/
RUN cargo fetch --manifest-path extern/filecoin-ffi/rust/Cargo.toml
COPY --from=rust-fil-proofs / /opt/curio/extern/rust-fil-proofs/
COPY --from=harness-overlay source-overrides/filecoin-ffi/ /opt/curio/extern/filecoin-ffi/
COPY --from=harness-overlay source-overrides/zigzag/filecoin-ffi/ /opt/curio/extern/filecoin-ffi/
COPY --from=harness-overlay source-overrides/zigzag-bench/Cargo.lock /opt/curio/extern/filecoin-ffi/rust/Cargo.lock
RUN set -eu; \
    fvm_source="$(find "${CARGO_HOME}/registry/src" -path '*/fvm-4.8.2' -type d -print -quit)"; \
    test -n "${fvm_source}"; \
    rm -rf extern/fvm-4.8.2-zigzag; \
    cp -a "${fvm_source}" extern/fvm-4.8.2-zigzag; \
    chmod -R u+w extern/fvm-4.8.2-zigzag
COPY --from=harness-overlay source-overrides/fvm-4.8.2-zigzag/ /opt/curio/extern/fvm-4.8.2-zigzag/
# Use the installed default from the pinned image, without fetching the
# development components named by the source's rust-toolchain.toml.
ARG ZIGZAG_TARGET_CPU=default
ARG ZIGZAG_LTO=off
ARG ZIGZAG_SHA_ASM=0
ARG ZIGZAG_GPU_BACKEND
ARG ZIGZAG_CUDA_ARCH=120
RUN set -eu; toolchain="$(rustup default | awk '{print $1}')"; \
    cd extern/filecoin-ffi/rust; \
    export RUSTUP_TOOLCHAIN="${toolchain}" CARGO_BUILD_JOBS=2; \
    if [ "${ZIGZAG_TARGET_CPU}" = native ]; then export RUSTFLAGS='-C target-cpu=native'; fi; \
    if [ "${ZIGZAG_LTO}" != off ]; then export CARGO_PROFILE_RELEASE_LTO="${ZIGZAG_LTO}" CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1; fi; \
    features='multicore-sdr,zigzag-bench,zigzag-setup-status'; \
    case "${ZIGZAG_GPU_BACKEND}" in cuda|opencl) features="${features},${ZIGZAG_GPU_BACKEND}-no-fvm" ;; esac; \
    export EC_GPU_CUDA_NVCC_ARGS="--optimize=3 --threads=2 --fatbin --generate-code=arch=compute_${ZIGZAG_CUDA_ARCH},code=sm_${ZIGZAG_CUDA_ARCH} --generate-code=arch=compute_${ZIGZAG_CUDA_ARCH},code=compute_${ZIGZAG_CUDA_ARCH}"; \
    if [ "${ZIGZAG_TARGET_CPU}" = generic ]; then features="${features},blst-portable"; fi; \
    if [ "${ZIGZAG_SHA_ASM}" = 1 ]; then features="${features},zigzag-sha-asm"; fi; \
    cargo tree --locked -e features --format '{p} features=[{f}]' --no-default-features --features "${features}" > /opt/zigzag-cargo-features.txt; \
    cargo build --release --locked \
         --bin porep-proof-microbench \
         --no-default-features \
         --features "${features}"

FROM ${ZIGZAG_RUST_TOOLCHAIN_IMAGE} AS runtime-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libhwloc15 \
      libltdl7 \
      libnuma1 \
      ocl-icd-libopencl1 \
    && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS runtime-cpu
FROM runtime-base AS runtime-opencl
FROM runtime-base AS runtime-cuda
RUN apt-get update && apt-get install -y --no-install-recommends python3 libglib2.0-0 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=cuda-tools /opt/nvidia/nsight-systems/ /opt/nvidia/nsight-systems/
RUN ln -s /opt/nvidia/nsight-systems/2026.3.2/bin/nsys /usr/local/bin/nsys && nsys --version
ENV NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility

FROM runtime-${ZIGZAG_GPU_BACKEND} AS zigzag-microbench
COPY --from=zigzag-builder /opt/curio/extern/filecoin-ffi/rust/target/release/porep-proof-microbench /usr/local/bin/porep-proof-microbench
COPY --from=zigzag-builder /opt/zigzag-cargo-features.txt /usr/local/share/zigzag/cargo-features.txt
COPY --from=harness-overlay --chmod=755 scripts/zigzag-gpu-run.sh /usr/local/bin/zigzag-gpu-run
COPY --from=harness-overlay scripts/summarize-zigzag-gpu.py /usr/local/share/zigzag/summarize-gpu.py

ARG RUST_FIL_PROOFS_COMMIT
ARG RUST_FIL_PROOFS_SOURCE_SHA256
ARG ZIGZAG_SOURCE_OVERRIDES_SHA256
ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE
ARG ZIGZAG_TARGET_CPU
ARG ZIGZAG_LTO
ARG ZIGZAG_SHA_ASM
ARG ZIGZAG_GPU_BACKEND
ARG ZIGZAG_CUDA_ARCH
LABEL io.porep-market.zigzag.rust-fil-proofs.commit="${RUST_FIL_PROOFS_COMMIT}" \
      io.porep-market.zigzag.gpu-backend="${ZIGZAG_GPU_BACKEND}" \
      io.porep-market.zigzag.cuda-arch="${ZIGZAG_CUDA_ARCH}" \
      io.porep-market.zigzag.rust-fil-proofs.source-sha256="${RUST_FIL_PROOFS_SOURCE_SHA256}" \
      io.porep-market.zigzag.source-overrides.sha256="${ZIGZAG_SOURCE_OVERRIDES_SHA256}" \
      io.porep-market.zigzag.rust-toolchain.image="${ZIGZAG_RUST_TOOLCHAIN_IMAGE}" \
      io.porep-market.zigzag.target-cpu="${ZIGZAG_TARGET_CPU}" \
      io.porep-market.zigzag.lto="${ZIGZAG_LTO}" \
      io.porep-market.zigzag.sha-asm="${ZIGZAG_SHA_ASM}"
