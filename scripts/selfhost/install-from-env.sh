#!/usr/bin/env bash

set -euo pipefail

MOS_SELFHOST_CONFIG="${MOS_SELFHOST_CONFIG:-/etc/mos-selfhost.env}"
STAMP_FILE="${MOS_SELFHOST_STAMP_FILE:-/var/lib/mos-selfhost/bootstrap.done}"

log() {
  printf '\n[%s] %s\n' "mos-install" "$1"
}

fail() {
  printf '[mos-install] ERROR: %s\n' "$1" >&2
  exit 1
}

ensure_root() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this installer as root."
}

ensure_ubuntu() {
  [[ -f /etc/os-release ]] || fail "Cannot determine operating system."
  # shellcheck disable=SC1091
  source /etc/os-release

  [[ "${ID:-}" == "ubuntu" ]] || fail "This installer currently targets Ubuntu Server 24.04 LTS."
  [[ "${VERSION_ID:-}" == "24.04" ]] || fail "Expected Ubuntu 24.04 LTS, got ${PRETTY_NAME:-unknown}."
}

load_config() {
  [[ -f "${MOS_SELFHOST_CONFIG}" ]] || fail "Missing installer handoff config: ${MOS_SELFHOST_CONFIG}"

  set -a
  # shellcheck disable=SC1090
  source "${MOS_SELFHOST_CONFIG}"
  set +a

  REPO_DIR="${REPO_DIR:-/opt/my-own-suite}"
  MOS_REPO_URL="${MOS_REPO_URL:-https://github.com/rpuls/my-own-suite.git}"
  MOS_REPO_REF="${MOS_REPO_REF:-staging}"
  MOS_UPDATE_TRACK="${MOS_UPDATE_TRACK:-branch}"
  MOS_UPDATE_REF="${MOS_UPDATE_REF:-${MOS_REPO_REF}}"
  MOS_HOSTNAME="${MOS_HOSTNAME:-mos}"
  MOS_PRIMARY_USER="${PRIMARY_USER:-${MOS_PRIMARY_USER:-mos}}"
  MOS_STACK_DOMAIN="${MOS_STACK_DOMAIN:-mos.home}"
  MOS_PUBLIC_DOMAIN="${MOS_PUBLIC_DOMAIN:-}"
  MOS_INSTALLER_KIND="${MOS_INSTALLER_KIND:-unknown}"
  INSTALL_DOCKER="${INSTALL_DOCKER:-1}"
  INSTALL_NODE="${INSTALL_NODE:-1}"
  CLONE_REPO_IF_MISSING="${CLONE_REPO_IF_MISSING:-1}"
  AUTO_START_STACK="${AUTO_START_STACK:-1}"

  export REPO_DIR
  export MOS_REPO_URL
  export MOS_REPO_REF
  export MOS_UPDATE_TRACK
  export MOS_UPDATE_REF
  export MOS_HOSTNAME
  export MOS_PRIMARY_USER
  export MOS_STACK_DOMAIN
  export MOS_PUBLIC_DOMAIN
  export MOS_INSTALLER_KIND
  export INSTALL_DOCKER
  export INSTALL_NODE
  export CLONE_REPO_IF_MISSING
  export AUTO_START_STACK
  export MOS_SELFHOST_CONFIG
}

validate_hostname() {
  local label="$1"
  local value="$2"

  [[ -n "${value}" ]] || fail "${label} cannot be empty."
  [[ "${value}" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$ ]] || fail "${label} must be a single hostname label using only letters, numbers, and hyphens."
}

validate_linux_user() {
  local label="$1"
  local value="$2"

  [[ -n "${value}" ]] || fail "${label} cannot be empty."
  [[ "${value}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "${label} must be a valid Linux username."
}

validate_absolute_path() {
  local label="$1"
  local value="$2"

  [[ -n "${value}" ]] || fail "${label} cannot be empty."
  [[ "${value}" == /* ]] || fail "${label} must be an absolute path."
  [[ "${value}" != *$'\n'* ]] || fail "${label} cannot contain newlines."
}

validate_domain() {
  local label="$1"
  local value="$2"

  [[ -n "${value}" ]] || fail "${label} cannot be empty."
  [[ "${value}" != *".."* ]] || fail "${label} cannot contain empty labels: ${value}"
  [[ "${value}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || fail "${label} contains unsupported characters: ${value}"
}

validate_config() {
  validate_absolute_path "REPO_DIR" "${REPO_DIR}"
  validate_linux_user "MOS_PRIMARY_USER" "${MOS_PRIMARY_USER}"
  validate_hostname "MOS_HOSTNAME" "${MOS_HOSTNAME}"
  validate_domain "MOS_STACK_DOMAIN" "${MOS_STACK_DOMAIN}"

  case "${MOS_UPDATE_TRACK}" in
    stable | branch) ;;
    *) fail "MOS_UPDATE_TRACK must be either stable or branch." ;;
  esac

  case "${INSTALL_DOCKER}" in
    0 | 1) ;;
    *) fail "INSTALL_DOCKER must be 0 or 1." ;;
  esac

  case "${INSTALL_NODE}" in
    0 | 1) ;;
    *) fail "INSTALL_NODE must be 0 or 1." ;;
  esac

  case "${CLONE_REPO_IF_MISSING}" in
    0 | 1) ;;
    *) fail "CLONE_REPO_IF_MISSING must be 0 or 1." ;;
  esac

  case "${AUTO_START_STACK}" in
    0 | 1) ;;
    *) fail "AUTO_START_STACK must be 0 or 1." ;;
  esac
}

ensure_seed_tools() {
  if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    return
  fi

  log "Installing installer seed tools"
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git
}

ensure_repo_checkout() {
  if [[ -f "${REPO_DIR}/package.json" ]]; then
    log "Using existing repo checkout at ${REPO_DIR}"
    return
  fi

  [[ "${CLONE_REPO_IF_MISSING}" == "1" ]] || fail "Repo checkout is missing at ${REPO_DIR}, and cloning is disabled."

  log "Cloning My Own Suite into ${REPO_DIR}"
  mkdir -p "$(dirname "${REPO_DIR}")"
  git clone "${MOS_REPO_URL}" "${REPO_DIR}"

  if [[ -n "${MOS_REPO_REF}" ]]; then
    (
      cd "${REPO_DIR}"
      git fetch --all --tags
      git checkout "${MOS_REPO_REF}"
    )
  fi
}

run_bootstrap() {
  local bootstrapScript="${REPO_DIR}/scripts/selfhost/bootstrap-ubuntu.sh"
  [[ -f "${bootstrapScript}" ]] || fail "Bootstrap script not found: ${bootstrapScript}"

  log "Starting shared Ubuntu bootstrap"
  bash "${bootstrapScript}"
}

mark_complete() {
  mkdir -p "$(dirname "${STAMP_FILE}")"
  touch "${STAMP_FILE}"

  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files mos-selfhost-bootstrap.service >/dev/null 2>&1; then
    systemctl disable mos-selfhost-bootstrap.service >/dev/null 2>&1 || true
  fi
}

main() {
  ensure_root
  ensure_ubuntu

  if [[ -f "${STAMP_FILE}" ]]; then
    log "Installer already completed; nothing to do."
    exit 0
  fi

  load_config
  validate_config
  ensure_seed_tools
  ensure_repo_checkout
  run_bootstrap
  mark_complete

  log "Installer handoff complete."
}

main "$@"
