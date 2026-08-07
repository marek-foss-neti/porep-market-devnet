ARG CURIO_TEST_IMAGE=porep-market-curio-devnet/curio-all-in-one:ce15c0c92209
#############################################################################
FROM ${CURIO_TEST_IMAGE}

ARG BUILD_VERSION=0.1

LABEL org.opencontainers.image.version=$BUILD_VERSION \
      org.opencontainers.image.authors="Curio Dev Team" \
      name="lotus-dev" \
      maintainer="Curio Dev Team" \
      vendor="Curio Dev Team" \
      version=$BUILD_VERSION \
      release=$BUILD_VERSION \
      summary="This image is used to host the lotus dev service" \
      description="This image is used to host the lotus dev service"

EXPOSE 1234
EXPOSE 9090
ENV LOTUS_SKIP_GENESIS_CHECK=_yes_
ENV GENESIS_PATH=/var/lib/genesis
ENV SECTOR_SIZE=8388608
ENV LOTUS_FEVM_ENABLEETHRPC=true


WORKDIR /app
RUN mkdir -p /app

COPY entrypoint.sh /app
COPY --from=harness-overlay patches/curio/0002-lotus-entrypoint-zigzag-runtime-only.patch /tmp/lotus-entrypoint-zigzag-runtime-only.patch
RUN git apply /tmp/lotus-entrypoint-zigzag-runtime-only.patch \
    && rm -f /tmp/lotus-entrypoint-zigzag-runtime-only.patch

USER root

ENTRYPOINT ["./entrypoint.sh"]
