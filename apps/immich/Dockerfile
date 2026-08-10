FROM ghcr.io/immich-app/immich-server:v3.1.0@sha256:079cc990b26a88d71f96027341c67329cb11829d4c341ce33b3718fe0f84cbfa

# Disable Immich's enabled-by-default new-version check: MOS controls when Immich
# updates are offered, so an in-app prompt for a release MOS does not ship yet is
# misleading. Side effect: no scheduled requests to version.immich.cloud. Applied
# through the upstream-supported IMMICH_CONFIG_FILE mechanism; the manifest points
# IMMICH_CONFIG_FILE at this baked-in file.
COPY immich-config.json /etc/immich/immich-config.json
