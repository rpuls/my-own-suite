# Radicale MOS app package.

# tomsquest/docker-radicale 3.8.3.0 (Radicale 3.8.3).
FROM tomsquest/docker-radicale@sha256:a3b1b452f4bc3d1aee43015b85bc2d9ee5de0ff7e96d5d2b47f1d889aa682409

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
