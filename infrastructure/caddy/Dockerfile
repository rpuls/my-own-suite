FROM caddy:2.11.6-builder@sha256:f5b1a66449d305280e559dba0ab9f7ce9a2a14c527c79d7c6fb48abc8f895818 AS builder

RUN xcaddy build v2.11.6 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/acmedns@v0.7.0 \
  --output /out/caddy

FROM scratch
COPY --from=builder /out/caddy /caddy
ENTRYPOINT ["/caddy"]
