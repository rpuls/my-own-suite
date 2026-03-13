FROM authelia/authelia:4.39.15@sha256:d23ee3c721d465b4749cc58541cda4aebe5aa6f19d7b5ce0afebb44ebee69591

COPY entrypoint.sh /entrypoint.sh
COPY assets /config/assets

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
