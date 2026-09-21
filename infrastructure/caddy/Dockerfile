FROM caddy:2.11.3-builder@sha256:d57008618f743e6308058d7bd990eb3489dfd04e2b82978cca7b953e1b491fc7 AS builder

RUN xcaddy build v2.10.2 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --output /out/caddy

FROM scratch
COPY --from=builder /out/caddy /caddy
ENTRYPOINT ["/caddy"]
