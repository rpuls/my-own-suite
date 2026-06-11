#!/usr/bin/env bash

set -euo pipefail

MOS_REPO_URL="${MOS_REPO_URL:-https://github.com/rpuls/my-own-suite.git}"
MOS_REPO_REF="${MOS_REPO_REF:-staging}"
MOS_UPDATE_TRACK="${MOS_UPDATE_TRACK:-branch}"
MOS_UPDATE_REF="${MOS_UPDATE_REF:-${MOS_REPO_REF}}"
REPO_DIR="${REPO_DIR:-/opt/my-own-suite}"
MOS_HOSTNAME="${MOS_HOSTNAME:-mos}"
MOS_PRIMARY_USER="${MOS_PRIMARY_USER:-mos}"
MOS_STACK_DOMAIN="${MOS_STACK_DOMAIN:-}"
MOS_PUBLIC_DOMAIN="${MOS_PUBLIC_DOMAIN:-}"
MOS_OWNER_NAME="${MOS_OWNER_NAME:-Suite Owner}"
MOS_OWNER_EMAIL="${MOS_OWNER_EMAIL:-}"
MOS_OWNER_PASSWORD="${MOS_OWNER_PASSWORD:-}"
MOS_LINUX_PASSWORD="${MOS_LINUX_PASSWORD:-}"
MOS_INSTALLER_CORE_URL="${MOS_INSTALLER_CORE_URL:-}"
MOS_REUSE_INSTALLER_CORE="${MOS_REUSE_INSTALLER_CORE:-0}"
INSTALL_CORE_PATH="${INSTALL_CORE_PATH:-/usr/local/bin/mos-selfhost-install-from-env.sh}"

log() {
  printf '\n[%s] %s\n' "mos-cloud-install" "$1"
}

fail() {
  printf '[mos-cloud-install] ERROR: %s\n' "$1" >&2
  exit 1
}

has_tty() {
  [[ -r /dev/tty && -w /dev/tty ]]
}

prompt_value() {
  local var_name="$1"
  local label="$2"
  local fallback="${3:-}"
  local current_value="${!var_name:-}"
  local answer

  if [[ -n "${current_value}" ]]; then
    return
  fi

  if ! has_tty; then
    if [[ -n "${fallback}" ]]; then
      printf -v "${var_name}" '%s' "${fallback}"
      return
    fi
    fail "Missing ${var_name}. Re-run with ${var_name}=... before the install command."
  fi

  if [[ -n "${fallback}" ]]; then
    printf '%s [%s]: ' "${label}" "${fallback}" > /dev/tty
  else
    printf '%s: ' "${label}" > /dev/tty
  fi
  IFS= read -r answer < /dev/tty
  printf -v "${var_name}" '%s' "${answer:-${fallback}}"
}

prompt_secret() {
  local var_name="$1"
  local label="$2"
  local current_value="${!var_name:-}"
  local answer

  if [[ -n "${current_value}" ]]; then
    return
  fi

  if ! has_tty; then
    fail "Missing ${var_name}. Re-run with ${var_name}=... before the install command."
  fi

  printf '%s: ' "${label}" > /dev/tty
  IFS= read -r -s answer < /dev/tty
  printf '\n' > /dev/tty
  [[ -n "${answer}" ]] || fail "${var_name} cannot be empty."
  printf -v "${var_name}" '%s' "${answer}"
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-18
    return
  fi

  od -An -tx1 -N9 /dev/urandom | tr -d ' \n'
}

quote_env() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
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

validate_inputs() {
  validate_absolute_path "REPO_DIR" "${REPO_DIR}"
  validate_absolute_path "INSTALL_CORE_PATH" "${INSTALL_CORE_PATH}"
  validate_hostname "MOS_HOSTNAME" "${MOS_HOSTNAME}"
  validate_linux_user "MOS_PRIMARY_USER" "${MOS_PRIMARY_USER}"
  validate_domain "MOS_STACK_DOMAIN" "${MOS_STACK_DOMAIN}"

  case "${MOS_UPDATE_TRACK}" in
    stable | branch) ;;
    *) fail "MOS_UPDATE_TRACK must be either stable or branch." ;;
  esac

  case "${MOS_REUSE_INSTALLER_CORE}" in
    0 | 1) ;;
    *) fail "MOS_REUSE_INSTALLER_CORE must be 0 or 1." ;;
  esac

  [[ -n "${MOS_OWNER_EMAIL}" ]] || fail "MOS_OWNER_EMAIL cannot be empty."
  [[ -n "${MOS_OWNER_PASSWORD}" ]] || fail "MOS_OWNER_PASSWORD cannot be empty."
}

write_selfhost_env() {
  log "Writing /etc/mos-selfhost.env"
  cat > /etc/mos-selfhost.env <<EOF
REPO_DIR=$(quote_env "${REPO_DIR}")
MOS_REPO_URL=$(quote_env "${MOS_REPO_URL}")
MOS_REPO_REF=$(quote_env "${MOS_REPO_REF}")
MOS_UPDATE_TRACK=$(quote_env "${MOS_UPDATE_TRACK}")
MOS_UPDATE_REF=$(quote_env "${MOS_UPDATE_REF}")
MOS_HOSTNAME=$(quote_env "${MOS_HOSTNAME}")
MOS_PRIMARY_USER=$(quote_env "${MOS_PRIMARY_USER}")
MOS_STACK_DOMAIN=$(quote_env "${MOS_STACK_DOMAIN}")
MOS_PUBLIC_DOMAIN=$(quote_env "${MOS_PUBLIC_DOMAIN}")
MOS_OWNER_NAME=$(quote_env "${MOS_OWNER_NAME}")
MOS_OWNER_EMAIL=$(quote_env "${MOS_OWNER_EMAIL}")
MOS_OWNER_PASSWORD=$(quote_env "${MOS_OWNER_PASSWORD}")
MOS_INSTALLER_KIND='cloud-ssh'
INSTALL_DOCKER=1
INSTALL_NODE=1
CLONE_REPO_IF_MISSING=1
AUTO_START_STACK=1
MOS_CONTROL_PLANE_ONLY=1
EOF
  chmod 0600 /etc/mos-selfhost.env
}

ensure_ubuntu() {
  [[ -f /etc/os-release ]] || fail "Cannot determine operating system."
  # shellcheck disable=SC1091
  source /etc/os-release

  [[ "${ID:-}" == "ubuntu" ]] || fail "This installer currently targets Ubuntu Server 24.04 LTS."
  [[ "${VERSION_ID:-}" == "24.04" ]] || fail "Expected Ubuntu 24.04 LTS, got ${PRETTY_NAME:-unknown}."
}

ensure_root() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this installer as root, for example: curl -fsSL <url> | sudo bash"
}

ensure_seed_tools() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi

  log "Installing first-boot tools"
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
}

ensure_primary_user() {
  if id -u "${MOS_PRIMARY_USER}" >/dev/null 2>&1; then
    log "Using existing Linux user ${MOS_PRIMARY_USER}"
    return
  fi

  if [[ -z "${MOS_LINUX_PASSWORD}" ]]; then
    MOS_LINUX_PASSWORD="$(random_password)"
    log "Generated Linux password for ${MOS_PRIMARY_USER}: ${MOS_LINUX_PASSWORD}"
  fi

  log "Creating Linux user ${MOS_PRIMARY_USER}"
  useradd -m -s /bin/bash "${MOS_PRIMARY_USER}"
  printf '%s:%s\n' "${MOS_PRIMARY_USER}" "${MOS_LINUX_PASSWORD}" | chpasswd
  usermod -aG sudo "${MOS_PRIMARY_USER}"
}

default_installer_core_url() {
  if [[ "${MOS_REPO_URL}" == "https://github.com/rpuls/my-own-suite.git" ]]; then
    printf 'https://raw.githubusercontent.com/rpuls/my-own-suite/%s/scripts/selfhost/install-from-env.sh' "${MOS_REPO_REF}"
    return
  fi

  printf ''
}

install_core() {
  if [[ "${MOS_REUSE_INSTALLER_CORE}" == "1" && -f "${INSTALL_CORE_PATH}" ]]; then
    log "Using existing installer core at ${INSTALL_CORE_PATH}"
    chmod 0755 "${INSTALL_CORE_PATH}"
    return
  fi

  local core_url="${MOS_INSTALLER_CORE_URL:-$(default_installer_core_url)}"
  [[ -n "${core_url}" ]] || fail "Set MOS_INSTALLER_CORE_URL for custom repositories."

  log "Installing shared MOS installer core"
  mkdir -p "$(dirname "${INSTALL_CORE_PATH}")"
  curl -fsSL "${core_url}" -o "${INSTALL_CORE_PATH}"
  chmod 0755 "${INSTALL_CORE_PATH}"
}

collect_inputs() {
  prompt_value MOS_STACK_DOMAIN "Suite domain" "mos.example.com"
  prompt_value MOS_OWNER_NAME "Suite owner name" "Suite Owner"
  prompt_value MOS_OWNER_EMAIL "Suite owner email"
  prompt_secret MOS_OWNER_PASSWORD "Suite owner password"
  prompt_value MOS_PRIMARY_USER "Linux username" "mos"
}

main() {
  ensure_root
  ensure_ubuntu
  collect_inputs
  validate_inputs
  ensure_seed_tools
  ensure_primary_user
  write_selfhost_env
  install_core

  log "Starting shared MOS installer core"
  "${INSTALL_CORE_PATH}"

  log "Cloud install handoff complete"
  printf '\nOpen Suite Manager after DNS points at this server:\n'
  printf '  http://suite-manager.%s/setup/\n' "${MOS_STACK_DOMAIN}"
}

main "$@"
