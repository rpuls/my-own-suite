#!/bin/sh
set -eu

SEAHUB_SETTINGS_FILE="/shared/seafile/conf/seahub_settings.py"

# Railway can run this image on hosts where syslog-ng version differs from
# the config syntax bundled in the image. Normalize the config before my_init.
if [ -f /etc/syslog-ng/syslog-ng.conf ]; then
  sed -i "s/@version: 4.3/@version: 3.35/g" /etc/syslog-ng/syslog-ng.conf || true
  sed -i "s/stats(freq(0));/stats_freq(0);/g" /etc/syslog-ng/syslog-ng.conf || true
fi

append_if_missing() {
  file="$1"
  pattern="$2"
  line="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "$line" >> "$file"
  fi
}

patch_seahub_proxy_settings() {
  if [ ! -f "$SEAHUB_SETTINGS_FILE" ]; then
    return 0
  fi

  # Railway (and most PaaS ingress) terminates TLS at the proxy.
  # These settings make Django trust forwarded scheme/host so CSRF checks pass.
  append_if_missing "$SEAHUB_SETTINGS_FILE" "SECURE_PROXY_SSL_HEADER" "SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')"
  append_if_missing "$SEAHUB_SETTINGS_FILE" "USE_X_FORWARDED_HOST" "USE_X_FORWARDED_HOST = True"

  # Keep trusted origin exact and without trailing slash.
  if [ -n "${SEAFILE_SERVER_HOSTNAME:-}" ]; then
    append_if_missing "$SEAHUB_SETTINGS_FILE" "CSRF_TRUSTED_ORIGINS" "CSRF_TRUSTED_ORIGINS = ['https://${SEAFILE_SERVER_HOSTNAME}']"
  fi
}

# Patch bootstrap default for first initialization.
if [ -n "${MEMCACHED_SERVER:-}" ]; then
  sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" /scripts/bootstrap.py

  # Patch already-initialized instances too.
  if [ -f "$SEAHUB_SETTINGS_FILE" ]; then
    sed -i "s|LOCATION': 'memcached:11211'|LOCATION': '${MEMCACHED_SERVER}'|g" "$SEAHUB_SETTINGS_FILE"
  fi
fi

# Private networking may connect from IPv6 addresses. Upstream bootstrap sets
# MYSQL_USER_HOST to %.%.%.% (IPv4 style), which can fail on IPv6.
DB_USER_HOST="${DB_USER_HOST:-%}"
sed -i "s|'MYSQL_USER_HOST': '%.%.%.%'|'MYSQL_USER_HOST': '${DB_USER_HOST}'|g" /scripts/bootstrap.py || true

# Apply proxy/CSRF settings for existing installs.
patch_seahub_proxy_settings

# First boot creates seahub_settings.py later. Wait briefly and patch once.
(
  i=0
  while [ $i -lt 300 ]; do
    if [ -f "$SEAHUB_SETTINGS_FILE" ]; then
      patch_seahub_proxy_settings
      break
    fi
    i=$((i + 1))
    sleep 1
  done
) &

exec /sbin/my_init -- /scripts/enterpoint.sh
