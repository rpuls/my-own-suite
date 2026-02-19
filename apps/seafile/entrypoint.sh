#!/bin/sh
set -eu

# Railway can run this image on hosts where syslog-ng version differs from
# the config syntax bundled in the image. Normalize the config before my_init.
if [ -f /etc/syslog-ng/syslog-ng.conf ]; then
  sed -i "s/@version: 4.3/@version: 3.35/g" /etc/syslog-ng/syslog-ng.conf || true
  sed -i "s/stats(freq(0));/stats_freq(0);/g" /etc/syslog-ng/syslog-ng.conf || true
fi

# Patch bootstrap default for first initialization.
if [ -n "${MEMCACHED_SERVER:-}" ]; then
  sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" /scripts/bootstrap.py

  # Patch already-initialized instances too.
  if [ -f /shared/seafile/conf/seahub_settings.py ]; then
    sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" /shared/seafile/conf/seahub_settings.py
  fi
fi

# Railway private networking may connect from IPv6 addresses. Upstream bootstrap
# sets MYSQL_USER_HOST to %.%.%.% (IPv4 style), which causes "Access denied"
# for seafile@<ipv6>. Widen to '%' for compatibility.
DB_USER_HOST="${DB_USER_HOST:-%}"
sed -i "s|'MYSQL_USER_HOST': '%.%.%.%'|'MYSQL_USER_HOST': '${DB_USER_HOST}'|g" /scripts/bootstrap.py || true

exec /sbin/my_init -- /scripts/enterpoint.sh
