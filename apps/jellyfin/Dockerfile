# Jellyfin 12.4 (tag 12.4.20261026-211555), multi-arch index.
FROM jellyfin/jellyfin@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771

COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/bin/bash", "/mos-entrypoint.sh"]
