#### Environment variables

- `DATABASE_URL`: Database connection string (required).
- `DOMAIN`: Public URL used by Vaultwarden.
- `ADMIN_TOKEN`: Token for admin panel access.
- `WEBSOCKET_ENABLED`: Enables websocket notifications.
- `ROCKET_PORT` / `PORT`: Runtime port binding (platform-dependent).
- Shared SMTP inputs from `deploy/vps/services/suite-manager/.env` when enabled:
  - `SMTP_ENABLED`
  - `SMTP_HOST`
  - `SMTP_FROM`
  - `SMTP_FROM_NAME`
  - `SMTP_USERNAME`
  - `SMTP_PASSWORD`
  - `SMTP_PORT`
  - `SMTP_SECURITY` (`starttls`, `force_tls`, or `off`)

#### Service: `vaultwarden-postgres`

Environment variables:
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

Volumes:
- Required: `/var/lib/postgresql/data`

Healthcheck:
- `pg_isready --dbname=$POSTGRES_DB --username=$POSTGRES_USER`

#### Required service wiring

- `vaultwarden` -> `vaultwarden-postgres`: set `DATABASE_URL` to `postgresql://<user>:<pass>@vaultwarden-postgres:5432/<db>`
- `vaultwarden` -> `suite-manager`: optional shared SMTP settings can be sourced from the shared suite env file for password-reset, verification, and invite-capable flows.

#### Optional SMTP behavior

- SMTP is fully optional and is intended for operators who already have access to an SMTP server.
- When `SMTP_ENABLED` is explicitly false, the MOS startup wrapper removes shared SMTP variables before Vaultwarden validates its mail configuration.
- When the shared SMTP values are present, Vaultwarden can use them for verification mail, welcome mail, master password hint mail, and similar account emails.
- The canonical setup and troubleshooting guide lives in the dedicated advanced SMTP doc: [Optional email with SMTP](/docs/optional-email-with-smtp).
- Some email-triggering actions may feel slow if the configured SMTP server is unreachable, because Vaultwarden sends those emails as part of the request flow.

