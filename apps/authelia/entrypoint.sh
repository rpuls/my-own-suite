#!/bin/sh
set -eu

CONFIG_DIR="/config"
DATA_DIR="${MOS_AUTHELIA_DATA_DIR:-/data}"
CONFIG_FILE="${CONFIG_DIR}/configuration.yml"
USERS_FILE="${CONFIG_DIR}/users_database.yml"
STORAGE_PATH="${DATA_DIR}/db.sqlite3"
NOTIFICATION_PATH="${DATA_DIR}/notification.txt"

mkdir -p "${CONFIG_DIR}" "${DATA_DIR}"

require_env() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

require_env "MOS_AUTHELIA_SESSION_SECRET"
require_env "MOS_AUTHELIA_STORAGE_ENCRYPTION_KEY"
require_env "MOS_AUTHELIA_OWNER_EMAIL"
require_env "MOS_AUTHELIA_OWNER_PASSWORD"
require_env "MOS_AUTHELIA_JWT_SECRET"
require_env "DOMAIN"

OWNER_DISPLAY_NAME="${MOS_AUTHELIA_OWNER_DISPLAY_NAME:-Suite Owner}"
AUTH_PORTAL_URL="${MOS_AUTHELIA_PUBLIC_URL:-https://auth.${DOMAIN}}"
COOKIE_DOMAIN="${MOS_AUTHELIA_SESSION_DOMAIN:-${DOMAIN}}"
THEME="${MOS_AUTHELIA_THEME:-auto}"

OWNER_PASSWORD_HASH="$(
  authelia crypto hash generate argon2 \
    --password "${MOS_AUTHELIA_OWNER_PASSWORD}" \
    | awk -F': ' '/^Digest:/ { print $2 }'
)"

if [ -z "${OWNER_PASSWORD_HASH}" ]; then
  echo "Failed to generate Authelia password hash." >&2
  exit 1
fi

cat > "${USERS_FILE}" <<EOF
users:
  suite-owner:
    displayname: ${OWNER_DISPLAY_NAME}
    email: ${MOS_AUTHELIA_OWNER_EMAIL}
    password: ${OWNER_PASSWORD_HASH}
EOF

case "${THEME}" in
  light|dark|grey|oled|auto)
    ;;
  *)
    echo "Invalid MOS_AUTHELIA_THEME: ${THEME}. Expected one of: light, dark, grey, oled, auto." >&2
    exit 1
    ;;
esac

cat > "${CONFIG_FILE}" <<EOF
theme: ${THEME}

server:
  address: 'tcp://0.0.0.0:9091'
  asset_path: '/config/assets'
  endpoints:
    authz:
      forward-auth:
        implementation: 'ForwardAuth'

log:
  level: 'info'

authentication_backend:
  password_reset:
    disable: true
  file:
    path: '${USERS_FILE}'
    search:
      email: true
      case_insensitive: true

access_control:
  default_policy: 'deny'
  rules:
    - domain: 'homepage.${DOMAIN}'
      policy: 'one_factor'
    - domain: 'suite-manager.${DOMAIN}'
      policy: 'one_factor'

session:
  secret: '${MOS_AUTHELIA_SESSION_SECRET}'
  cookies:
    - domain: '${COOKIE_DOMAIN}'
      authelia_url: '${AUTH_PORTAL_URL}'
      default_redirection_url: 'https://homepage.${DOMAIN}'
      name: 'mos_session'

storage:
  encryption_key: '${MOS_AUTHELIA_STORAGE_ENCRYPTION_KEY}'
  local:
    path: '${STORAGE_PATH}'

notifier:
  filesystem:
    filename: '${NOTIFICATION_PATH}'

identity_validation:
  reset_password:
    jwt_secret: '${MOS_AUTHELIA_JWT_SECRET}'
EOF

exec authelia --config "${CONFIG_FILE}"
