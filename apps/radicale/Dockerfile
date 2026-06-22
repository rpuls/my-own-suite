# Radicale Service (Platform Deployments)
# Uses a stable /apps/radicale build target while reusing the upstream image.

FROM tomsquest/docker-radicale@sha256:c9f10974f2f79c475946de463ccf142779c868fe00e41c9664a19f9bd58adeda

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
