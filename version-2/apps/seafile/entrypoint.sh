#!/bin/sh
set -eu

SEAHUB_SETTINGS_FILE="/shared/seafile/conf/seahub_settings.py"

# Some hosts expose a syslog-ng version older than the syntax bundled in this
# image. Normalize it before the upstream init process starts.
if [ -f /etc/syslog-ng/syslog-ng.conf ]; then
  sed -i "s/@version: 4.3/@version: 3.35/g" /etc/syslog-ng/syslog-ng.conf || true
  sed -i "s/stats(freq(0));/stats_freq(0);/g" /etc/syslog-ng/syslog-ng.conf || true
fi

upsert_setting() {
  file="$1"
  key="$2"
  line="$3"
  if grep -q "^${key}[[:space:]]*=" "$file"; then
    sed -i "s|^${key}[[:space:]]*=.*|${line}|g" "$file"
  else
    echo "$line" >> "$file"
  fi
}

patch_seahub_proxy_settings() {
  if [ ! -f "$SEAHUB_SETTINGS_FILE" ]; then
    return 0
  fi

  protocol="${SEAFILE_SERVER_PROTOCOL:-http}"

  if [ -n "${SEAFILE_SERVER_HOSTNAME:-}" ]; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "SERVICE_URL" "SERVICE_URL = \"${protocol}://${SEAFILE_SERVER_HOSTNAME}\""
    upsert_setting "$SEAHUB_SETTINGS_FILE" "FILE_SERVER_ROOT" "FILE_SERVER_ROOT = \"${protocol}://${SEAFILE_SERVER_HOSTNAME}/seafhttp\""
    upsert_setting "$SEAHUB_SETTINGS_FILE" "CSRF_TRUSTED_ORIGINS" "CSRF_TRUSTED_ORIGINS = ['https://${SEAFILE_SERVER_HOSTNAME}', 'http://${SEAFILE_SERVER_HOSTNAME}']"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "SECURE_PROXY_SSL_HEADER" "SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "USE_X_FORWARDED_HOST" "USE_X_FORWARDED_HOST = True"
}

patch_seahub_proxy_settings

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
