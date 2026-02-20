# OnlyOffice

Self-hosted OnlyOffice Community Document Server.

## Environment Variables

- `TZ` - Container time zone (example: `Europe/Amsterdam`)
- `ALLOW_PRIVATE_IP_ADDRESS` - Allow callbacks to private/loopback addresses (`true` for localhost/private-network setups)
- `ALLOW_META_IP_ADDRESS` - Allow callbacks to metadata/non-public cloud address ranges (useful on PaaS ingress networks)
- `ONLYOFFICE_EXAMPLE_USERADDRESS` - Stable identifier used by the built-in `/example` app for file paths (`127.0.0.1` recommended)
- `JWT_ENABLED` - Enable JWT protection (`true` or `false`)
- `JWT_SECRET` - JWT secret used when `JWT_ENABLED=true`

## Notes

- The VPS deployment builds from `apps/onlyoffice/Dockerfile` (based on `onlyoffice/documentserver`).
- The image enables `ds:example` and `ds:adminpanel` autostart so `/example/` and `/admin/` are available without manual setup.
- Homepage is configured to link directly to `http://onlyoffice.${DOMAIN}/example/` for immediate first-run usability.
- The entrypoint sets a deterministic `X-Forwarded-For` value for `/example` using `ONLYOFFICE_EXAMPLE_USERADDRESS` to avoid `new.docx` "File not found" path drift.
- For PaaS deployments, the entrypoint maps nginx to `${PORT}` automatically.
- The entrypoint also strips wrapping quotes from key env values (`PORT`, `TZ`, `ALLOW_PRIVATE_IP_ADDRESS`, `ALLOW_META_IP_ADDRESS`, `ONLYOFFICE_EXAMPLE_USERADDRESS`, `JWT_ENABLED`, `JWT_SECRET`).
- On managed ingress platforms, set `ALLOW_META_IP_ADDRESS=true` when document callbacks/downloads fail with request-filter errors.
- Keep `JWT_ENABLED=false` until integrating with a document provider.
- Before integrating with Seafile, set `JWT_ENABLED=true` and define a strong `JWT_SECRET`.
