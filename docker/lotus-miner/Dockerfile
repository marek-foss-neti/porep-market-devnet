ARG CURIO_TEST_IMAGE=porep-market-curio-devnet/curio-all-in-one:ce15c0c92209
#############################################################################
FROM ${CURIO_TEST_IMAGE}

ARG BUILD_VERSION=0.1

LABEL org.opencontainers.image.version=$BUILD_VERSION \
      org.opencontainers.image.authors="Curio Dev Team" \
      name="lotus-miner-dev" \
      maintainer="Curio Dev Team" \
      vendor="Curio Dev Team" \
      version=$BUILD_VERSION \
      release=$BUILD_VERSION \
      summary="This image is used to host the lotus-miner dev service" \
      description="This image is used to host the lotus-miner dev service"

EXPOSE 2345
ENV LOTUS_SKIP_GENESIS_CHECK=_yes_
ENV GENESIS_PATH=/var/lib/genesis
ENV SECTOR_SIZE=8388608


WORKDIR /app
RUN mkdir -p /app

COPY entrypoint.sh /app
RUN perl -0pi -e 's/lotus wait-api/lotus wait-api --timeout "\${LOTUS_WAIT_API_TIMEOUT:-10m}"/g' /app/entrypoint.sh

USER root

ENTRYPOINT ["./entrypoint.sh"]
