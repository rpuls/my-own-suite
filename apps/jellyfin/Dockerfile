# Jellyfin 12.3 (tag 12.3.20261023-013714), multi-arch index.
FROM jellyfin/jellyfin@sha256:2038fe038ab3876a80f6e7b7e0aef6607b032c7dc0c9b3ad3296d0b2eba3bbb5

COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/bin/bash", "/mos-entrypoint.sh"]
