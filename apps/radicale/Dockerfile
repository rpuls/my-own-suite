# Radicale MOS app package.

# tomsquest/docker-radicale 3.7.6.0 (Radicale 3.7.6).
FROM tomsquest/docker-radicale@sha256:7faa88e5d04b47c3972ee3d825921ff23a258c99f3a4784c9feeb687da8b64a2

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
