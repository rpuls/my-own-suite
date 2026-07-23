FROM ghcr.io/immich-app/immich-server:v3.0.3@sha256:c716dc20f957aafd89fa9d284a2ec63e25c9e2d8d8e87c6197d540a3dce237db

# MOS hardening: disable Immich's enabled-by-default new-version check so the
# server makes no scheduled outbound release-check requests to GitHub. Applied
# through the upstream-supported IMMICH_CONFIG_FILE mechanism; the manifest points
# IMMICH_CONFIG_FILE at this baked-in file.
COPY immich-config.json /etc/immich/immich-config.json
