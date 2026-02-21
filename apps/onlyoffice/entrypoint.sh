#!/bin/sh
set -eu

strip_wrapping_quotes() {
  # Strip one leading and trailing matching quote if present.
  # shellcheck disable=SC2001
  echo "$1" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'$/\\1/"
}

normalize_env_var() {
  var_name="$1"
  eval "raw_value=\${$var_name:-}"
  if [ -n "$raw_value" ]; then
    clean_value="$(strip_wrapping_quotes "$raw_value")"
    export "$var_name=$clean_value"
  fi
}

escape_for_single_quote() {
  # Escape single quotes for insertion into a single-quoted JS string.
  echo "$1" | sed "s/'/'\\\\''/g"
}

configure_nginx_listen_port() {
  target_port="$1"

  for cfg in \
    /etc/onlyoffice/documentserver/nginx/ds.conf.tmpl \
    /etc/onlyoffice/documentserver/nginx/ds-ssl.conf.tmpl \
    /etc/nginx/conf.d/ds.conf
  do
    if [ -f "$cfg" ]; then
      sed -i "s/listen 0.0.0.0:80;/listen 0.0.0.0:${target_port};/g" "$cfg"
      sed -i "s/listen \\[::\\]:80 default_server;/listen [::]:${target_port} default_server;/g" "$cfg"
      sed -i "s/listen 127.0.0.1:80;/listen 127.0.0.1:${target_port};/g" "$cfg"
      sed -i "s/listen \\[::1\\]:80;/listen [::1]:${target_port};/g" "$cfg"
    fi
  done
}

sync_securelink_keys() {
  # Keep docservice/nginx secure-link keys in sync; avoids Editor.bin 403
  # on some managed platforms after restarts/redeploys.
  if [ -x /app/ds/documentserver-update-securelink.sh ]; then
    /app/ds/documentserver-update-securelink.sh >/dev/null 2>&1 || true
  elif [ -x /usr/bin/documentserver-update-securelink.sh ]; then
    /usr/bin/documentserver-update-securelink.sh >/dev/null 2>&1 || true
  fi
}

configure_storage_secret() {
  # Force a stable secure-link secret used for /cache/files URLs.
  # If STORAGE_FS_SECRET is not set, fall back to JWT_SECRET when provided.
  storage_secret="${STORAGE_FS_SECRET:-${JWT_SECRET:-}}"
  if [ -z "$storage_secret" ]; then
    return 0
  fi

  json_bin="/var/www/onlyoffice/documentserver/npm/json"
  if [ ! -x "$json_bin" ]; then
    return 0
  fi

  escaped_secret="$(escape_for_single_quote "$storage_secret")"
  "$json_bin" -I -f /etc/onlyoffice/documentserver/local.json -e "this.storage=this.storage||{}; this.storage.fs=this.storage.fs||{}; this.storage.fs.secretString='${escaped_secret}'" >/dev/null 2>&1 || true
}

# Railway and similar platforms may present values with wrapping quotes.
normalize_env_var "PORT"
normalize_env_var "TZ"
normalize_env_var "ALLOW_PRIVATE_IP_ADDRESS"
normalize_env_var "ALLOW_META_IP_ADDRESS"
normalize_env_var "JWT_ENABLED"
normalize_env_var "JWT_SECRET"
normalize_env_var "STORAGE_FS_SECRET"

# On platform deployments, bind nginx to the platform-provided PORT.
if [ -n "${PORT:-}" ]; then
  configure_nginx_listen_port "${PORT}"
fi

configure_storage_secret
sync_securelink_keys

exec /app/ds/run-document-server.sh
