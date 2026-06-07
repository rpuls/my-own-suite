#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root."
  exit 1
fi

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SERVICE_TEMPLATE="${REPO_DIR}/agents/selfhost/service/systemd/mos-service-agent.service"
SERVICE_TARGET="/etc/systemd/system/mos-service-agent.service"
CLI_TEMPLATE="${REPO_DIR}/agents/selfhost/service/mos-service"
CLI_TARGET="/usr/local/bin/mos-service"
ENV_FILE="/etc/mos-service-agent.env"
TOKEN_DIR="/etc/mos-service-agent"
TOKEN_FILE="${TOKEN_DIR}/auth.token"
SOCKET_DIR="/run/mos-service-agent"
SOCKET_PATH="${SOCKET_DIR}/agent.sock"

if [[ ! -f "${SERVICE_TEMPLATE}" ]]; then
  echo "Service template not found: ${SERVICE_TEMPLATE}"
  exit 1
fi

if [[ ! -f "${CLI_TEMPLATE}" ]]; then
  echo "CLI template not found: ${CLI_TEMPLATE}"
  exit 1
fi

mkdir -p "${TOKEN_DIR}" "${SOCKET_DIR}"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "${TOKEN_FILE}"
  chmod 0600 "${TOKEN_FILE}"
fi

cat > "${ENV_FILE}" <<EOF
MOS_SERVICE_AGENT_REPO_DIR=${REPO_DIR}
MOS_SERVICE_AGENT_SOCKET_PATH=${SOCKET_PATH}
MOS_SERVICE_AGENT_TOKEN_FILE=${TOKEN_FILE}
EOF

sed "s|__REPO_DIR__|${REPO_DIR}|g" "${SERVICE_TEMPLATE}" > "${SERVICE_TARGET}"
sed "s|__REPO_DIR__|${REPO_DIR}|g" "${CLI_TEMPLATE}" > "${CLI_TARGET}"
chmod 0755 "${CLI_TARGET}"

systemctl daemon-reload
systemctl enable mos-service-agent.service
systemctl restart mos-service-agent.service

echo "Installed MOS service agent."
echo "Socket path: ${SOCKET_PATH}"
echo "CLI helper: ${CLI_TARGET}"
