ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE=docker.io/library/rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62

FROM ${ZIGZAG_RUST_TOOLCHAIN_IMAGE} AS zigzag-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      clang \
      git \
      libhwloc-dev \
      ocl-icd-opencl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/curio
COPY --from=curio-source / /opt/curio/
RUN cargo fetch --manifest-path extern/filecoin-ffi/rust/Cargo.toml
COPY --from=rust-fil-proofs / /opt/curio/extern/rust-fil-proofs/
COPY --from=harness-overlay source-overrides/filecoin-ffi/ /opt/curio/extern/filecoin-ffi/
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
RUN toolchain="$(rustup default | awk '{print $1}')" \
    && cd extern/filecoin-ffi/rust \
    && RUSTUP_TOOLCHAIN="${toolchain}" CARGO_BUILD_JOBS=2 cargo build --release --locked \
         --bin porep-proof-microbench \
         --no-default-features \
         --features multicore-sdr,zigzag-bench,zigzag-setup-status

FROM ${ZIGZAG_RUST_TOOLCHAIN_IMAGE} AS zigzag-microbench

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libhwloc15 \
      libltdl7 \
      libnuma1 \
      ocl-icd-libopencl1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=zigzag-builder /opt/curio/extern/filecoin-ffi/rust/target/release/porep-proof-microbench /usr/local/bin/porep-proof-microbench

ARG RUST_FIL_PROOFS_COMMIT
ARG RUST_FIL_PROOFS_SOURCE_SHA256
ARG ZIGZAG_SOURCE_OVERRIDES_SHA256
ARG ZIGZAG_RUST_TOOLCHAIN_IMAGE
LABEL io.porep-market.zigzag.rust-fil-proofs.commit="${RUST_FIL_PROOFS_COMMIT}" \
      io.porep-market.zigzag.rust-fil-proofs.source-sha256="${RUST_FIL_PROOFS_SOURCE_SHA256}" \
      io.porep-market.zigzag.source-overrides.sha256="${ZIGZAG_SOURCE_OVERRIDES_SHA256}" \
      io.porep-market.zigzag.rust-toolchain.image="${ZIGZAG_RUST_TOOLCHAIN_IMAGE}"
