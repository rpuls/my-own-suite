#### Container build

- `Dockerfile` builds a custom Caddy binary with `github.com/caddy-dns/cloudflare` so MOS can use ACME DNS-01 certificates for private local HTTPS.
- Base images are pinned by digest.
- The Cloudflare DNS module is pinned in the `xcaddy build` command.

#### Environment variables

- `DOMAIN`: Shared stack domain used by generated Caddy routes.
- `PUBLIC_URL_SCHEME`: Shared public URL protocol used by generated MOS app links.
- `MOS_TLS_MODE`: Caddy route mode. Supported values are `off` and `cloudflare-dns01`.
- `CADDY_ACME_EMAIL`: ACME account email used when `MOS_TLS_MODE=cloudflare-dns01`.
- `CLOUDFLARE_API_TOKEN`: Scoped Cloudflare API token used by Caddy for DNS-01 challenges when `MOS_TLS_MODE=cloudflare-dns01`.

#### Generated config

- Static config entrypoint: `deploy/vps/Caddyfile`.
- Generated built-in MOS routes: `deploy/vps/generated/caddy/built-in-routes.caddy`.
- Generated global Caddy options: `deploy/vps/generated/caddy/global-options.caddy`.
- Generated external proxy routes: `deploy/vps/generated/caddy/external-proxies.caddy`.

`npm run vps:init` refreshes the generated built-in route and global-options snippets from `DOMAIN`, `PUBLIC_URL_SCHEME`, and `MOS_TLS_MODE`.
