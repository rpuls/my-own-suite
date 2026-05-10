#!/usr/bin/env bash

set -euo pipefail

STAMP_FILE="/var/lib/mos-selfhost/bootstrap.done"
mkdir -p "$(dirname "${STAMP_FILE}")"

if [[ -f "${STAMP_FILE}" ]]; then
  exit 0
fi

MOS_SELFHOST_CONFIG="/etc/mos-selfhost.env"

set -a
source "${MOS_SELFHOST_CONFIG}"
set +a

export REPO_DIR
export MOS_REPO_URL
export MOS_REPO_REF
export MOS_UPDATE_TRACK="${MOS_UPDATE_TRACK:-branch}"
export MOS_UPDATE_REF="${MOS_UPDATE_REF:-${MOS_REPO_REF}}"
export MOS_PRIMARY_USER="${PRIMARY_USER:-${MOS_PRIMARY_USER:-mos}}"
export INSTALL_DOCKER
export INSTALL_NODE
export CLONE_REPO_IF_MISSING
export AUTO_START_STACK
export MOS_SELFHOST_CONFIG

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

touch "${STAMP_FILE}"
systemctl disable mos-selfhost-bootstrap.service
