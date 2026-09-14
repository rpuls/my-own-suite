# Radicale MOS app package.

# tomsquest/docker-radicale 3.7.6.0 (Radicale 3.7.6).
FROM tomsquest/docker-radicale@sha256:6e94400a7c0b7e847ba77e35bc482b78ddf26c19c492aa0911d44ac8ef97f3dc

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
