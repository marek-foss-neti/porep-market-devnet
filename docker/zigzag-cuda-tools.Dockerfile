# Shared, pinned tools for the isolated CUDA images; no host package installation.
ARG CUDA_TOOLKIT_IMAGE=docker.io/nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66
FROM ${CUDA_TOOLKIT_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --retry 3 \
      https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/nsight-systems-2026.3.2_2026.3.2.476-1_amd64.deb \
      -o /tmp/nsight.deb \
    && echo 'e9bf0ff9c613ff5545095a4177676a9579cb666e78c8621c3792f3559e2c1690  /tmp/nsight.deb' | sha256sum -c - \
    && dpkg-deb --extract /tmp/nsight.deb / \
    && rm /tmp/nsight.deb && rm -rf /var/lib/apt/lists/*
