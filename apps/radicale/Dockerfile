# Radicale Service (Platform Deployments)
# Uses a stable /apps/radicale build target while reusing the upstream image.

FROM tomsquest/docker-radicale@sha256:bc941b4440c2cb4e8742ac95356ee17982174932c271817a1327b71e7cddc3b6

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
