FROM caddy:2.11.6-builder@sha256:9fa405e7bb28572759e7c75bea68ed39c4266a509f0c0237c464c6e13ed4dc25 AS builder

RUN xcaddy build v2.11.6 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/acmedns@v0.7.0 \
  --output /out/caddy

FROM scratch
COPY --from=builder /out/caddy /caddy
ENTRYPOINT ["/caddy"]
