FROM --platform=$BUILDPLATFORM caddy:2.11.4-builder@sha256:f2b98918658f949a3c533f2c73bd0806e3f2576ccf8eb182c8b1690c977007ea AS builder

RUN xcaddy build \
  --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy@sha256:cb9d71ad83182011b79355cd57692686374bd78d6fe327efe0ff8507da03ab13

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
