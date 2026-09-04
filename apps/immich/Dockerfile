FROM ghcr.io/immich-app/immich-server:v3.1.0@sha256:079cc990b26a88d71f96027341c67329cb11829d4c341ce33b3718fe0f84cbfa

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
