FROM ghcr.io/immich-app/immich-server:v3.4.1@sha256:4351dd621899ecc8ed317ae87cdcaeb968ec8ba4f9d8053d913a73eb6f6dd7c2

# The baked config disables Immich's enabled-by-default new-version check (MOS
# controls when Immich updates are offered; side effect: no scheduled requests to
# version.immich.cloud) and keeps the FUTO Backups beta off, which MOS does not
# ship. It is now the *base* config: the wrapper entrypoint
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
