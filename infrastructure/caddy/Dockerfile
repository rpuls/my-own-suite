FROM caddy:2.11.9-builder@sha256:345264d8c6b50f44f4a4d507d4e6b6bcae40eef2f210d70f76e717fd8cc31baf AS builder

RUN xcaddy build v2.11.6 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/acmedns@v0.7.0 \
  --output /out/caddy

FROM scratch
COPY --from=builder /out/caddy /caddy
ENTRYPOINT ["/caddy"]
