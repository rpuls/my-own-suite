# Seafile

Self-hosted file sync and share solution.

## Environment Variables

- `DB_HOST` - MySQL host (required)
- `DB_PORT` - MySQL port (optional, default `3306`)
- `DB_ROOT_PASSWD` - MySQL root password (required)
- `SEAFILE_SERVER_HOSTNAME` - Public hostname
- `SEAFILE_ADMIN_EMAIL` - Admin email
- `SEAFILE_ADMIN_PASSWORD` - Admin password
- `TIME_ZONE` - Timezone (optional, default UTC)

## Railway Compatibility

This image includes a wrapper entrypoint for Railway deployments:

- `MYSQLHOST` -> `DB_HOST` (if `DB_HOST` is unset)
- `MYSQLPORT` -> `DB_PORT` (if `DB_PORT` is unset)
- `MYSQL_ROOT_PASSWORD` -> `DB_ROOT_PASSWD` (if `DB_ROOT_PASSWD` is unset)
- Fallback: `MYSQLPASSWORD` -> `DB_ROOT_PASSWD` (if `DB_ROOT_PASSWD` is unset)

For memcached, Seafile upstream defaults to `memcached:11211`.
This image supports overrides via:

- `MEMCACHED_SERVER` (preferred), e.g. `memcached.railway.internal:11211`
- `MEMCACHE_PRIVATE_SERVER` (Railway export), auto-mapped to `MEMCACHED_SERVER`
