#!/bin/sh
set -eu

strip_wrapping_quotes() {
  echo "$1" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
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
      sed -i "s/listen \[::\]:80 default_server;/listen [::]:${target_port} default_server;/g" "$cfg"
      sed -i "s/listen 127.0.0.1:80;/listen 127.0.0.1:${target_port};/g" "$cfg"
      sed -i "s/listen \[::1\]:80;/listen [::1]:${target_port};/g" "$cfg"
    fi
  done
}

sync_secure_link_secret() {
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
      sed -i 's|^[[:space:]]*set \$secure_link_secret .*;|  set \$secure_link_secret '"${SECURE_LINK_SECRET}"';|g' "$cfg"
    fi
  done
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

ai_settings() {
  url="$(json_string "$MOS_AI_BASE_URL")"
  key="$(json_string "${MOS_AI_API_KEY:-}")"
  model="$(json_string "$MOS_AI_MODEL")"
  # The plugin reads each provider model's endpoints (1 is chat completions) and crashes silently without them.
  printf '{"providers":{"My Own Suite":{"name":"My Own Suite","url":%s,"key":%s,"models":[{"id":%s,"name":%s,"endpoints":[1],"options":{}}]}},' "$url" "$key" "$model" "$model"
  printf '"models":[{"id":%s,"name":%s,"provider":"My Own Suite","capabilities":1}],' "$model" "$model"
  printf '"actions":{"Chat":{"model":%s},"Summarization":{"model":%s},"Translation":{"model":%s},"TextAnalyze":{"model":%s}}}' "$model" "$model" "$model" "$model"
}

# Runs at every start, so turning the AI service off in MOS also removes what an
# earlier start added. With a server-side provider, users get no AI settings of their own.
configure_ai() {
  config=/etc/onlyoffice/documentserver/local.json
  json=/var/www/onlyoffice/documentserver/npm/json
  plugin=/var/www/onlyoffice/documentserver/sdkjs-plugins/ai

  "$json" -q -I -f "$config" -e 'delete this.aiSettings'
  rm -rf "$plugin"
  if [ -z "${MOS_AI_BASE_URL:-}" ] || [ -z "${MOS_AI_MODEL:-}" ]; then
    return 0
  fi

  cp -R /opt/onlyoffice/ai-plugin "$plugin"
  "$json" -q -I -f "$config" -e "this.aiSettings = $(ai_settings)"
}

prepare_supervisor_log_dirs() {
  mkdir -p \
    /var/log/onlyoffice/documentserver/adminpanel \
    /var/log/COMPANY_NAME/documentserver/adminpanel
}

normalize_env_var "PORT"
normalize_env_var "TZ"
normalize_env_var "ALLOW_PRIVATE_IP_ADDRESS"
normalize_env_var "ALLOW_META_IP_ADDRESS"
normalize_env_var "METRICS_ENABLED"
normalize_env_var "JWT_ENABLED"
normalize_env_var "JWT_SECRET"
normalize_env_var "SECURE_LINK_SECRET"

if [ -n "${PORT:-}" ]; then
  configure_nginx_listen_port "${PORT}"
fi

sync_secure_link_secret
configure_ai
prepare_supervisor_log_dirs

exec /app/ds/run-document-server.sh
