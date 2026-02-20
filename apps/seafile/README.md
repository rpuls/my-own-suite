# Seafile

Self-hosted file sync and share solution.

## Requirements

- Use MySQL `8.x` (recommended: `mysql:8.0`).
- Mount a persistent volume at `/shared` for Seafile data/config.
- Provide a reachable Memcached server (`host:port`).

## Environment Variables

- `DB_HOST` - Hostname/IP of your MySQL server that Seafile should connect to.
- `DB_PORT` - MySQL port (usually `3306`).
- `DB_ROOT_PASSWD` - MySQL root password used during first-time Seafile bootstrap.
- `DB_USER_HOST` - MySQL host pattern for grants on the generated `seafile` DB user.
  Use `%` for broad compatibility (including IPv6/private networks).
- `MEMCACHED_SERVER` - Memcached endpoint in `host:port` format.
- `SEAFILE_ADMIN_EMAIL` - Initial Seafile admin email.
- `SEAFILE_ADMIN_PASSWORD` - Initial Seafile admin password.
- `SEAFILE_SERVER_HOSTNAME` - Public hostname users access Seafile with (no protocol).
- `SEAFILE_SERVER_PROTOCOL` - Public protocol (`https` when behind TLS proxy).
- `TIME_ZONE` - Time zone name, e.g. `Europe/Amsterdam`.

## Persistence

Seafile must have persistent storage mounted at:

- `/shared`

Without `/shared`, credentials/config can drift between restarts and bootstrap/login issues will occur.

## Notes

- Seafile creates and uses `ccnet_db`, `seafile_db`, and `seahub_db` in MySQL.
- Some database UIs default to another schema (often `railway`) and may show "no tables" there.
- If login fails with CSRF errors behind a reverse proxy, ensure:
  - `SEAFILE_SERVER_HOSTNAME` is correct
  - `SEAFILE_SERVER_PROTOCOL=https`
  - trusted proxy/CSRF settings are applied in `seahub_settings.py` (this image entrypoint handles that automatically).
