FROM ghcr.io/immich-app/immich-server:v3.0.2@sha256:e027fa892e4c20ea8cba262e0d98dbaba14af873903408928e252596608a3a47

# MOS hardening: disable Immich's enabled-by-default new-version check so the
# server makes no scheduled outbound release-check requests to GitHub. Applied
# through the upstream-supported IMMICH_CONFIG_FILE mechanism; the manifest points
# IMMICH_CONFIG_FILE at this baked-in file.
COPY immich-config.json /etc/immich/immich-config.json
