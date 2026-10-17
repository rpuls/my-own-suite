# Jellyfin 12.2 (tag 12.2.20261005-225228), multi-arch index.
FROM jellyfin/jellyfin@sha256:357724bf0ae27a672c7cbaa899db2d9abeb13dbd8657ccce750258a4c059d037

COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/bin/bash", "/mos-entrypoint.sh"]
