ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE=docker.io/library/rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62
ARG GO_BUILDER_IMAGE=docker.io/library/golang:1.26-trixie@sha256:4ee9ffa999b4583ce281939cdff828763083610292f252279a0cee77473bd9a7
ARG BASE_CURIO_IMAGE=porep-market-curio-devnet/curio:ce15c0c92209

FROM ${ZIGZAG_RUST_TOOLCHAIN_IMAGE} AS rust-toolchain

FROM ${GO_BUILDER_IMAGE} AS blst-builder
WORKDIR /opt/blst
COPY --from=blst-source /build.sh ./build.sh
COPY --from=blst-source /build/ ./build/
COPY --from=blst-source /src/ ./src/
COPY --from=blst-source /bindings/ ./bindings/
COPY --from=blst-source /LICENSE ./LICENSE
RUN ./build.sh && test -s libblst.a

FROM ${GO_BUILDER_IMAGE} AS curio-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates clang git jq libhwloc-dev make \
      ocl-icd-libopencl1 ocl-icd-opencl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH} \
    XDG_CACHE_HOME=/tmp
WORKDIR /opt/curio
COPY --from=curio-source / /opt/curio/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download
RUN cargo fetch --manifest-path extern/filecoin-ffi/rust/Cargo.toml
COPY --from=rust-fil-proofs / /opt/curio/extern/rust-fil-proofs/
COPY --from=harness-overlay source-overrides/curio/ /opt/curio/
COPY --from=harness-overlay source-overrides/zigzag/curio/ /opt/curio/
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
COPY --from=blst-builder /opt/blst /opt/curio/extern/supraseal/deps/blst
ARG CURIO_COMMIT
ARG CURIO_FFI_COMMIT
ARG ZIGZAG_TARGET_CPU=default
ARG ZIGZAG_LTO=off
ARG ZIGZAG_SHA_ASM=0
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/opt/curio/extern/filecoin-ffi/rust/target \
    set -eu; \
    toolchain="$(rustup default | awk '{print $1}')"; \
    export RUSTUP_TOOLCHAIN="${toolchain}"; \
    if [ "${ZIGZAG_TARGET_CPU}" = generic ]; then export FFI_PORTABLE=1; fi; \
    if [ "${ZIGZAG_TARGET_CPU}" = native ]; then export RUSTFLAGS='-C target-cpu=native'; fi; \
    if [ "${ZIGZAG_LTO}" != off ]; then export CARGO_PROFILE_RELEASE_LTO="${ZIGZAG_LTO}" CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1; fi; \
    mkdir -p build; \
    touch build/.update-modules build/.blst-install; \
    RUSTUP_TOOLCHAIN="${toolchain}" \
    FFI_BUILD_FROM_SOURCE=1 FFI_GIT_COMMIT="${CURIO_FFI_COMMIT}" \
    FFI_ZIGZAG_SHA_ASM="${ZIGZAG_SHA_ASM}" FFI_USE_OPENCL=1 DISABLE_SUPRASEAL=1 \
    FFI_ZIGZAG_CARGO_FEATURES_FILE=/opt/zigzag-cargo-features.txt \
    CARGO_BUILD_JOBS=2 GOMAXPROCS=2 \
    make build CURIO_BUILD_COMMIT="${CURIO_COMMIT}" \
      CURIO_TAGS="cunative debug nosupraseal"; \
    test -s /opt/zigzag-cargo-features.txt

FROM ${BASE_CURIO_IMAGE} AS zigzag-curio
COPY --from=curio-builder /opt/curio/curio /usr/local/bin/curio-zigzag
COPY --from=harness-overlay --chmod=755 source-overrides/zigzag/curio/curio-cpu-launcher.sh /usr/local/bin/curio
COPY --from=harness-overlay scripts/zigzag-cpu-settings.sh /usr/local/share/zigzag/cpu-settings.sh
COPY --from=curio-builder /opt/zigzag-cargo-features.txt /usr/local/share/zigzag/cargo-features.txt
COPY --from=curio-builder /opt/curio/sptool /usr/local/bin/sptool-zigzag
COPY --from=harness-overlay --chmod=755 source-overrides/zigzag/curio/curio-cpu-launcher.sh /usr/local/bin/sptool
ARG CURIO_COMMIT
ARG RUST_FIL_PROOFS_COMMIT
ARG RUST_FIL_PROOFS_SOURCE_SHA256
ARG ZIGZAG_SOURCE_OVERRIDES_SHA256
ARG ZIGZAG_DOCKERFILE_SHA256
ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE
ARG ZIGZAG_TARGET_CPU
ARG ZIGZAG_LTO
ARG ZIGZAG_SHA_ASM
LABEL io.porep-market.curio.commit="${CURIO_COMMIT}" \
      io.porep-market.zigzag.split-proving="1" \
      io.porep-market.zigzag.rust-fil-proofs.commit="${RUST_FIL_PROOFS_COMMIT}" \
      io.porep-market.zigzag.rust-fil-proofs.source-sha256="${RUST_FIL_PROOFS_SOURCE_SHA256}" \
      io.porep-market.zigzag.source-overrides.sha256="${ZIGZAG_SOURCE_OVERRIDES_SHA256}" \
      io.porep-market.zigzag.dockerfile.sha256="${ZIGZAG_DOCKERFILE_SHA256}" \
      io.porep-market.zigzag.rust-toolchain.image="${ZIGZAG_RUST_TOOLCHAIN_IMAGE}" \
      io.porep-market.zigzag.target-cpu="${ZIGZAG_TARGET_CPU}" \
      io.porep-market.zigzag.lto="${ZIGZAG_LTO}" \
      io.porep-market.zigzag.sha-asm="${ZIGZAG_SHA_ASM}"
