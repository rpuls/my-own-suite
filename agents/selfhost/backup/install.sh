#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root."
  exit 1
fi

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SERVICE_TEMPLATE="${REPO_DIR}/agents/selfhost/backup/systemd/mos-backup-agent.service"
SERVICE_TARGET="/etc/systemd/system/mos-backup-agent.service"
CLI_TEMPLATE="${REPO_DIR}/agents/selfhost/backup/mos-backup"
CLI_TARGET="/usr/local/bin/mos-backup"
ENV_FILE="/etc/mos-backup-agent.env"
TOKEN_DIR="/etc/mos-backup-agent"
TOKEN_FILE="${TOKEN_DIR}/auth.token"
STATE_DIR="/var/lib/mos-backup-agent"
SOCKET_DIR="/run/mos-backup-agent"
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
MOS_BACKUP_AGENT_REPO_DIR=${REPO_DIR}
MOS_BACKUP_AGENT_STATE_DIR=${STATE_DIR}
MOS_BACKUP_AGENT_SOCKET_PATH=${SOCKET_PATH}
MOS_BACKUP_AGENT_TOKEN_FILE=${TOKEN_FILE}
EOF

sed "s|__REPO_DIR__|${REPO_DIR}|g" "${SERVICE_TEMPLATE}" > "${SERVICE_TARGET}"
sed "s|__REPO_DIR__|${REPO_DIR}|g" "${CLI_TEMPLATE}" > "${CLI_TARGET}"
chmod 0755 "${CLI_TARGET}"

systemctl daemon-reload
systemctl enable mos-backup-agent.service
systemctl restart mos-backup-agent.service

echo "Installed MOS backup agent."
echo "Socket path: ${SOCKET_PATH}"
echo "State dir: ${STATE_DIR}"
echo "CLI helper: ${CLI_TARGET}"
