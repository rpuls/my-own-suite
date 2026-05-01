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

sync_secure_link_secret() {
  # Ensure nginx uses the same secure-link secret configured for document server.
  if [ -z "${SECURE_LINK_SECRET:-}" ]; then
    return 0
  fi

  for cfg in \
    /etc/nginx/conf.d/ds.conf \
    /etc/onlyoffice/documentserver/nginx/ds.conf \
    /etc/onlyoffice/documentserver/nginx/ds.conf.tmpl \
    /etc/onlyoffice/documentserver/nginx/ds-ssl.conf.tmpl
  do
    if [ -f "$cfg" ]; then
      # shellcheck disable=SC2016
      sed -i 's|^[[:space:]]*set \$secure_link_secret .*;|  set \$secure_link_secret '"${SECURE_LINK_SECRET}"';|g' "$cfg"
    fi
  done
}

prepare_supervisor_log_dirs() {
  # ONLYOFFICE 9.1 adds an admin panel supervisor program. Some platform
  # starts can see the upstream placeholder path before it is normalized.
  mkdir -p \
    /var/log/onlyoffice/documentserver/adminpanel \
    /var/log/COMPANY_NAME/documentserver/adminpanel
}

# Railway and similar platforms may present values with wrapping quotes.
normalize_env_var "PORT"
normalize_env_var "TZ"
normalize_env_var "ALLOW_PRIVATE_IP_ADDRESS"
normalize_env_var "ALLOW_META_IP_ADDRESS"
normalize_env_var "JWT_ENABLED"
normalize_env_var "JWT_SECRET"
normalize_env_var "SECURE_LINK_SECRET"

# On platform deployments, bind nginx to the platform-provided PORT.
if [ -n "${PORT:-}" ]; then
  configure_nginx_listen_port "${PORT}"
fi

sync_secure_link_secret
prepare_supervisor_log_dirs

exec /app/ds/run-document-server.sh
