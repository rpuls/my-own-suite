# Radicale MOS app package.

# tomsquest/docker-radicale 3.7.6.0 (Radicale 3.7.6).
FROM tomsquest/docker-radicale@sha256:0b0a1894aed814db9ade750d3e086de2d708746a50c88c16a0b823349baf70ed

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
