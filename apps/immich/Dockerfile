FROM ghcr.io/immich-app/immich-server:v3.1.0@sha256:b434cb9287eea1471c9974845914d4dd328c9c2d652e446ed4930f99944f0ceb

# Disable Immich's enabled-by-default new-version check: MOS controls when Immich
# updates are offered, so an in-app prompt for a release MOS does not ship yet is
# misleading. Side effect: no scheduled requests to version.immich.cloud. Applied
# through the upstream-supported IMMICH_CONFIG_FILE mechanism; the manifest points
# IMMICH_CONFIG_FILE at this baked-in file.
COPY immich-config.json /etc/immich/immich-config.json
