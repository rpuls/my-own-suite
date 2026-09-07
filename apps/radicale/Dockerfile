# Radicale MOS app package.

# tomsquest/docker-radicale 3.7.6.0 (Radicale 3.7.6).
FROM tomsquest/docker-radicale@sha256:270eb79dcc26df0dc6535c0bdabf008cdc2e40bde8b34feab631cd6f2bb869c8

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
