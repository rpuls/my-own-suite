FROM caddy:2.11.8-builder@sha256:d4eb070c36154bd2d4c94b40359a03c6168346d5af5404963c74691ab77fb63f AS builder

RUN xcaddy build v2.11.6 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/acmedns@v0.7.0 \
  --output /out/caddy

FROM scratch
COPY --from=builder /out/caddy /caddy
ENTRYPOINT ["/caddy"]
