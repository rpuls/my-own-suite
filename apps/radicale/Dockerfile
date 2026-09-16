# Radicale MOS app package.

# tomsquest/docker-radicale 3.7.6.0 (Radicale 3.7.6).
FROM tomsquest/docker-radicale@sha256:664b0fffe6da06e5e4e292a0c2d9dfe576d6b5e15743ce071645d1cb30bbee18

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
