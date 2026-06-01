# Radicale Service (Platform Deployments)
# Uses a stable /apps/radicale build target while reusing the upstream image.

FROM tomsquest/docker-radicale@sha256:a7e08e5496a9fe434300ff08e5992b7baed03f833c34608042de864ee9d6541a

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
