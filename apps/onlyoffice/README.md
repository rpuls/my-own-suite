# OnlyOffice

Self-hosted document editor backend (OnlyOffice Document Server).

## Customizations in this project

- Startup wrapper normalizes selected env values.
- Supports dynamic listen port mapping for managed platforms.
- Synchronizes nginx `secure_link_secret` with `SECURE_LINK_SECRET`.

## Environment variables

- `TZ`: Container timezone.
- `ALLOW_PRIVATE_IP_ADDRESS`: Allow callbacks to private/loopback addresses.
- `ALLOW_META_IP_ADDRESS`: Allow callbacks to metadata/non-public address ranges.
- `JWT_ENABLED`: Enable JWT protection.
- `JWT_SECRET`: JWT secret used when JWT is enabled.
- `SECURE_LINK_SECRET`: Secret used for nginx secure-link validation of `/cache/files/...`.

## Persistence

- Required volume mount: `/var/www/onlyoffice/Data`
- This is required for VPS and managed platform deployments.

## Official website

- https://www.onlyoffice.com/
