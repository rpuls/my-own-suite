# Radicale MOS app package.

# tomsquest/docker-radicale 3.9.1.1 (Radicale 3.9.1).
FROM tomsquest/docker-radicale@sha256:3869c5c013da5d76132cdeaba1fa0804324119d0ef6f3eaaf18f310f64c6bdc9

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
