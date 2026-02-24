# Seafile

Self-hosted file sync and sharing service.

## Requirements

- Use MySQL `8.x` (recommended `mysql:8.0`).
- Provide a reachable Memcached server (`host:port`).
- Mount persistent storage at `/shared` for Seafile data and config.

## Customizations in this project

- Entry-point patches `seahub_settings.py` with proxy and OnlyOffice settings.
- Adds runtime patching for OnlyOffice internal callback/download URL handling.
- Patch targets are version-sensitive and should be revalidated after Seafile image upgrades.

## Environment variables

- `DB_HOST`: MySQL host for Seafile.
- `DB_PORT`: MySQL port (typically `3306`).
- `DB_ROOT_PASSWD`: MySQL root password used for Seafile bootstrap.
- `DB_USER_HOST`: Host pattern for Seafile DB grants (recommended `%`).
- `MEMCACHED_SERVER`: Memcached endpoint in `host:port` format.
- `SEAFILE_ADMIN_EMAIL`: Initial Seafile admin email.
- `SEAFILE_ADMIN_PASSWORD`: Initial Seafile admin password.
- `SEAFILE_SERVER_HOSTNAME`: Public Seafile hostname (no protocol).
- `SEAFILE_SERVER_PROTOCOL`: Public scheme (`http` or `https`).
- `TIME_ZONE`: Container timezone.
- `VERIFY_ONLYOFFICE_CERTIFICATE`: Toggle TLS verification for OnlyOffice callbacks.
- `ONLYOFFICE_APIJS_URL`: OnlyOffice Docs API JS URL. Enables OnlyOffice integration when set.
- `ONLYOFFICE_FORCE_SAVE`: Enables/disables OnlyOffice force-save behavior.
- `ONLYOFFICE_INTERNAL_SEAFILE_URL`: Internal Seafile URL for OnlyOffice server-to-server traffic.
- `ONLYOFFICE_JWT_SECRET`: JWT secret for OnlyOffice integration when JWT is enabled.

## Persistence

- Required volume mount: `/shared`
- Without `/shared`, config and runtime state can drift across restarts.

## Official website

- https://www.seafile.com/
