# Seafile

Self-hosted file sync and share solution.

## Environment Variables

- `DB_HOST` - MySQL host (required)
- `DB_PORT` - MySQL port (optional, default `3306`)
- `DB_ROOT_PASSWD` - MySQL root password (required)
- `DB_USER_HOST` - MySQL host pattern for `seafile` DB user creation (optional, default `%`)
- `SEAFILE_SERVER_HOSTNAME` - Public hostname
- `SEAFILE_ADMIN_EMAIL` - Admin email
- `SEAFILE_ADMIN_PASSWORD` - Admin password
- `MEMCACHED_SERVER` - Memcached host:port override (optional, default `memcached:11211`)
- `TIME_ZONE` - Timezone (optional, default UTC)
