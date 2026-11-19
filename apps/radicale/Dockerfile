# Radicale MOS app package.

# tomsquest/docker-radicale 3.9.2.0 (Radicale 3.9.2).
FROM tomsquest/docker-radicale@sha256:cc586f75ec709d45d15dfbf20e53bab99e85ee5a4d7beafc7bbf852b2f07a2da

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/venv/bin/radicale", "--config", "/config/config"]
