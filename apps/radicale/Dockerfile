# Radicale MOS app package.

# tomsquest/docker-radicale 3.8.1.1 (Radicale 3.8.1).
FROM tomsquest/docker-radicale@sha256:e6d8c17bc4d75f3fd40e52b20421ba244c17ca08fb01cd7dc90d5d78ba51b58d

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
