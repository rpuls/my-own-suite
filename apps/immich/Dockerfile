FROM ghcr.io/immich-app/immich-server:v3.2.4@sha256:04225d8995a221de3b73a6131fe25eed14448830e54998f30877a70f48c6ac13

# The baked config disables Immich's enabled-by-default new-version check (MOS
# controls when Immich updates are offered; side effect: no scheduled requests to
# version.immich.cloud). It is now the *base* config: the wrapper entrypoint
# merges the owner's shared email relay into it at startup and writes the runtime
# file the manifest points IMMICH_CONFIG_FILE at. /etc/immich is made writable so
# the runtime file can be regenerated regardless of the container user.
COPY immich-config.json /etc/immich/immich-config.base.json
COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh \
  && chmod +x /mos-entrypoint.sh \
  && mkdir -p /etc/immich \
  && chmod 0777 /etc/immich
ENTRYPOINT ["tini", "--", "/bin/bash", "/mos-entrypoint.sh"]
CMD []
