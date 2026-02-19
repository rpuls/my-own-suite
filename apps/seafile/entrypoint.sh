#!/bin/sh
set -eu

# Map Railway MySQL variables to Seafile expected variables.
# Keep explicit Seafile vars if user already provided them.
[ -n "${DB_HOST:-}" ] || [ -z "${MYSQLHOST:-}" ] || export DB_HOST="${MYSQLHOST}"
[ -n "${DB_PORT:-}" ] || [ -z "${MYSQLPORT:-}" ] || export DB_PORT="${MYSQLPORT}"

if [ -z "${DB_ROOT_PASSWD:-}" ]; then
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    export DB_ROOT_PASSWD="${MYSQL_ROOT_PASSWORD}"
  elif [ -n "${MYSQLPASSWORD:-}" ]; then
    export DB_ROOT_PASSWD="${MYSQLPASSWORD}"
  fi
fi

# Accept either MEMCACHED_SERVER or Railway's MEMCACHE_PRIVATE_SERVER.
if [ -z "${MEMCACHED_SERVER:-}" ] && [ -n "${MEMCACHE_PRIVATE_SERVER:-}" ]; then
  export MEMCACHED_SERVER="${MEMCACHE_PRIVATE_SERVER}"
fi

# Patch bootstrap default for first initialization.
if [ -n "${MEMCACHED_SERVER:-}" ]; then
  sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" /scripts/bootstrap.py

  # Patch already-initialized instances too.
  if [ -f /shared/seafile/conf/seahub_settings.py ]; then
    sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" /shared/seafile/conf/seahub_settings.py
  fi
fi

exec /sbin/my_init -- /scripts/enterpoint.sh
