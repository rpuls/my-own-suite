#### Environment variables

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
- `VERIFY_ONLYOFFICE_CERTIFICATE`: Toggle TLS verification for ONLYOFFICE callbacks.
- `ONLYOFFICE_APIJS_URL`: ONLYOFFICE Docs API JS URL. Enables ONLYOFFICE integration when set.
- `ONLYOFFICE_FORCE_SAVE`: Enables/disables ONLYOFFICE force-save behavior.
- `ONLYOFFICE_INTERNAL_SEAFILE_URL`: Internal Seafile URL for ONLYOFFICE server-to-server traffic.
- `ONLYOFFICE_JWT_SECRET`: JWT secret for ONLYOFFICE integration when JWT is enabled.
- Shared SMTP inputs from `deploy/vps/services/suite-manager/.env` when enabled:
  - `SMTP_ENABLED`
  - `SMTP_HOST`
  - `SMTP_PORT`
  - `SMTP_SECURITY` (`starttls`, `force_tls`, or `off`)
  - `SMTP_USERNAME`
  - `SMTP_PASSWORD`
  - `SMTP_FROM`

#### Volumes and persistence

- Required volume mount: `/shared`
- Without `/shared`, config and runtime state can drift across restarts.

#### Dependencies and integrations

Requirements:
- Use MySQL `8.x` (recommended `mysql:8.0`).
- Provide a reachable Memcached server (`host:port`).
- Mount persistent storage at `/shared` for Seafile data and config.

Integrations:
- Works with ONLYOFFICE for in-browser document editing.
- Can reuse the shared stack SMTP settings for password resets and share-link email delivery.

#### Optional SMTP behavior

- SMTP is fully optional and is intended for operators who already have access to an SMTP server.
- When `SMTP_ENABLED=true`, the shared SMTP values from `deploy/vps/services/suite-manager/.env` are written into `seahub_settings.py` at container start.
- Typical SMTP-backed Seafile features include password reset mail, share-link delivery, and other notification-style emails.
- The canonical setup and troubleshooting guide lives in the dedicated advanced SMTP doc: [Optional email with SMTP](/docs/optional-email-with-smtp).
- If mail-related actions appear to hang, Seafile may be waiting on the SMTP server during the live request path.

#### Customizations in this project

- Entry-point patches `seahub_settings.py` with proxy, ONLYOFFICE, and optional SMTP settings.
- Adds runtime patching for ONLYOFFICE internal callback/download URL handling.
- Patch targets are version-sensitive and should be revalidated after Seafile image upgrades.



