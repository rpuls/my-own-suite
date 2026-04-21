#!/usr/bin/env bash

set -euo pipefail

STAMP_FILE="/var/lib/mos-selfhost/bootstrap.done"
mkdir -p "$(dirname "${STAMP_FILE}")"

if [[ -f "${STAMP_FILE}" ]]; then
  exit 0
fi

source /etc/mos-selfhost.env

if [[ -f /etc/mos-selfhost-installer.env ]]; then
  source /etc/mos-selfhost-installer.env
fi

export REPO_DIR
export MOS_REPO_URL
export MOS_REPO_REF
export MOS_HOSTNAME
export MOS_STACK_DOMAIN
export MOS_PUBLIC_DOMAIN
export INSTALL_DOCKER
export INSTALL_NODE
export CLONE_REPO_IF_MISSING
export AUTO_START_STACK
export MOS_OWNER_NAME="${INSTALL_OWNER_NAME:-}"
export MOS_OWNER_EMAIL="${INSTALL_OWNER_EMAIL:-}"
export MOS_OWNER_PASSWORD="${INSTALL_OWNER_PASSWORD:-}"

if [[ ! -f "${REPO_DIR}/scripts/selfhost/bootstrap-ubuntu.sh" ]]; then
  mkdir -p "$(dirname "${REPO_DIR}")"
  git clone "${MOS_REPO_URL}" "${REPO_DIR}"

  if [[ -n "${MOS_REPO_REF}" ]]; then
    (
      cd "${REPO_DIR}"
      git fetch --all --tags
      git checkout "${MOS_REPO_REF}"
    )
  fi
fi

bash "${REPO_DIR}/scripts/selfhost/bootstrap-ubuntu.sh"

rm -f /etc/mos-selfhost-installer.env

touch "${STAMP_FILE}"
systemctl disable mos-selfhost-bootstrap.service
