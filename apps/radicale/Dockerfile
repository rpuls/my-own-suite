# Radicale Service (Platform Deployments)
# Uses a stable /apps/radicale build target while reusing the upstream image.

FROM tomsquest/docker-radicale@sha256:355cb506b07422707bb66ceefd3bd7e228755b5d7e2642065f18b049292c423f

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
