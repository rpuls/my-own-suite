#### Environment variables

- `DATABASE_URL`: Database connection string (required).
- `DOMAIN`: Public URL used by Vaultwarden.
- `ADMIN_TOKEN`: Token for admin panel access.
- `WEBSOCKET_ENABLED`: Enables websocket notifications.
- `ROCKET_PORT` / `PORT`: Runtime port binding (platform-dependent).

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



