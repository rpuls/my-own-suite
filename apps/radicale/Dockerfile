# Radicale Service (Platform Deployments)
# Uses a stable /apps/radicale build target while reusing the upstream image.

FROM tomsquest/docker-radicale@sha256:a1b2e78a4f6134fc8ad9375dff161debf8f54e4add398f852d209c6a8206ac91

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
