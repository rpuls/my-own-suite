# OnlyOffice

Self-hosted OnlyOffice Community Document Server.

## Environment Variables

- `TZ` - Container time zone (example: `Europe/Amsterdam`)
- `ALLOW_PRIVATE_IP_ADDRESS` - Allow callbacks to private/loopback addresses (`true` for localhost/private-network setups)
- `ALLOW_META_IP_ADDRESS` - Allow callbacks to metadata/non-public cloud address ranges (useful on PaaS ingress networks)
- `JWT_ENABLED` - Enable JWT protection (`true` or `false`)
- `JWT_SECRET` - JWT secret used when `JWT_ENABLED=true`
- `SECURE_LINK_SECRET` - Secret used by nginx secure-link validation for editor cache files (`/cache/files/...`)

## Persistence

- Mount persistent storage at `/var/www/onlyoffice/Data`.
- This is required on VPS and managed platforms (Railway, Dokploy, etc.).

## Notes

- The VPS deployment builds from `apps/onlyoffice/Dockerfile` (based on `onlyoffice/documentserver`).
- OnlyOffice should be treated as an editor backend, not a standalone document manager UX.
- Homepage links to `http://onlyoffice.${DOMAIN}` (landing page) until Seafile integration is enabled.
- The image enables `ds:adminpanel` autostart so `/admin/` is reachable after startup.
- For PaaS deployments, the entrypoint maps nginx to `${PORT}` automatically.
- The entrypoint strips wrapping quotes from key env values (`PORT`, `TZ`, `ALLOW_PRIVATE_IP_ADDRESS`, `ALLOW_META_IP_ADDRESS`, `JWT_ENABLED`, `JWT_SECRET`, `SECURE_LINK_SECRET`).
- On managed ingress platforms, set `ALLOW_META_IP_ADDRESS=true` when document callbacks/downloads fail with request-filter errors.
- On managed platforms, set an explicit `SECURE_LINK_SECRET` so nginx and document server use the same cache URL signing secret.
- Keep `JWT_ENABLED=false` until integrating with a document provider.
- Before integrating with Seafile, set `JWT_ENABLED=true` and define a strong `JWT_SECRET`.

## Runtime Modifications

- This image stays close to upstream `onlyoffice/documentserver`, with a small startup wrapper in `entrypoint.sh`.
- Why: managed platforms often inject `PORT` and env formatting that upstream scripts do not handle consistently.
- What is modified:
  - nginx listen port remap to `${PORT}` for PaaS compatibility
  - normalization of selected env vars
  - startup sync of nginx `secure_link_secret` from `SECURE_LINK_SECRET` to prevent `/cache/files/...` signature mismatches
- Maintenance note: if upstream startup/config templates change, re-validate these steps after image upgrades.
