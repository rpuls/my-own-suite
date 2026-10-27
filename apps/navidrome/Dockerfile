# Navidrome 0.64.2, amd64/arm64 multi-architecture index.
FROM navidrome/navidrome@sha256:38dc2727bfcfd5ede290f8ada114fc90368146f265ae4701ddddbcbe2a44ee52

COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/mos-entrypoint.sh"]
