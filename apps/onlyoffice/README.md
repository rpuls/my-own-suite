# OnlyOffice

Self-hosted OnlyOffice Community Document Server.

## Environment Variables

- `TZ` - Container time zone (example: `Europe/Amsterdam`)
- `ALLOW_PRIVATE_IP_ADDRESS` - Allow callbacks to private/loopback addresses (`true` for localhost/private-network setups)
- `ALLOW_META_IP_ADDRESS` - Allow callbacks to metadata/non-public cloud address ranges (useful on PaaS ingress networks)
- `JWT_ENABLED` - Enable JWT protection (`true` or `false`)
- `JWT_SECRET` - JWT secret used when `JWT_ENABLED=true`

## Notes

- The VPS deployment builds from `apps/onlyoffice/Dockerfile` (based on `onlyoffice/documentserver`).
- OnlyOffice should be treated as an editor backend, not a standalone document manager UX.
- Homepage links to `http://onlyoffice.${DOMAIN}` (landing page) until Seafile integration is enabled.
- The image enables `ds:adminpanel` autostart so `/admin/` is reachable after startup.
- For PaaS deployments, the entrypoint maps nginx to `${PORT}` automatically.
- The entrypoint strips wrapping quotes from key env values (`PORT`, `TZ`, `ALLOW_PRIVATE_IP_ADDRESS`, `ALLOW_META_IP_ADDRESS`, `JWT_ENABLED`, `JWT_SECRET`).
- On managed ingress platforms, set `ALLOW_META_IP_ADDRESS=true` when document callbacks/downloads fail with request-filter errors.
- Keep `JWT_ENABLED=false` until integrating with a document provider.
- Before integrating with Seafile, set `JWT_ENABLED=true` and define a strong `JWT_SECRET`.
