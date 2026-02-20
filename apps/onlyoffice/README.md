# OnlyOffice

Self-hosted OnlyOffice Community Document Server.

## Environment Variables

- `TZ` - Container time zone (example: `Europe/Amsterdam`)
- `ALLOW_PRIVATE_IP_ADDRESS` - Allow callbacks to private/loopback addresses (`true` for localhost/private-network setups)
- `JWT_ENABLED` - Enable JWT protection (`true` or `false`)
- `JWT_SECRET` - JWT secret used when `JWT_ENABLED=true`

## Notes

- The VPS deployment builds from `apps/onlyoffice/Dockerfile` (based on `onlyoffice/documentserver`).
- The image enables `ds:example` and `ds:adminpanel` autostart so `/example/` and `/admin/` are available without manual setup.
- Homepage is configured to link directly to `http://onlyoffice.${DOMAIN}/example/` for immediate first-run usability.
- Keep `JWT_ENABLED=false` until integrating with a document provider.
- Before integrating with Seafile, set `JWT_ENABLED=true` and define a strong `JWT_SECRET`.
