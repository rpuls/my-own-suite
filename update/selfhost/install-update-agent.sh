#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root."
  exit 1
fi

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SERVICE_TEMPLATE="${REPO_DIR}/update/selfhost/systemd/mos-update-agent.service"
SERVICE_TARGET="/etc/systemd/system/mos-update-agent.service"
CLI_TEMPLATE="${REPO_DIR}/update/selfhost/mos-update"
CLI_TARGET="/usr/local/bin/mos-update"
ENV_FILE="/etc/mos-update-agent.env"
TOKEN_DIR="/etc/mos-update-agent"
TOKEN_FILE="${TOKEN_DIR}/auth.token"
STATE_DIR="/var/lib/mos-update-agent"
SOCKET_DIR="/run/mos-update-agent"
SOCKET_PATH="${SOCKET_DIR}/agent.sock"

if [[ ! -f "${SERVICE_TEMPLATE}" ]]; then
  echo "Service template not found: ${SERVICE_TEMPLATE}"
  exit 1
fi

if [[ ! -f "${CLI_TEMPLATE}" ]]; then
  echo "CLI template not found: ${CLI_TEMPLATE}"
  exit 1
fi

mkdir -p "${TOKEN_DIR}" "${STATE_DIR}" "${STATE_DIR}/jobs" "${SOCKET_DIR}"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "${TOKEN_FILE}"
  chmod 0600 "${TOKEN_FILE}"
fi

cat > "${ENV_FILE}" <<EOF
MOS_UPDATE_AGENT_REPO_DIR=${REPO_DIR}
MOS_UPDATE_AGENT_STATE_DIR=${STATE_DIR}
MOS_UPDATE_AGENT_SOCKET_PATH=${SOCKET_PATH}
MOS_UPDATE_AGENT_TOKEN_FILE=${TOKEN_FILE}
EOF

sed "s|__REPO_DIR__|${REPO_DIR}|g" "${SERVICE_TEMPLATE}" > "${SERVICE_TARGET}"
sed "s|__REPO_DIR__|${REPO_DIR}|g" "${CLI_TEMPLATE}" > "${CLI_TARGET}"
chmod 0755 "${CLI_TARGET}"

systemctl daemon-reload
systemctl enable mos-update-agent.service
systemctl restart mos-update-agent.service

echo "Installed MOS update agent."
echo "Socket path: ${SOCKET_PATH}"
echo "State dir: ${STATE_DIR}"
echo "CLI helper: ${CLI_TARGET}"
