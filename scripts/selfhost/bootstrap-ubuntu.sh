#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root. Try: sudo bash scripts/selfhost/bootstrap-ubuntu.sh"
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Cannot determine operating system."
  exit 1
fi

source /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This bootstrap script currently targets Ubuntu Server 24.04 LTS."
  exit 1
fi

if [[ "${VERSION_ID:-}" != "24.04" ]]; then
  echo "Expected Ubuntu 24.04 LTS, got ${PRETTY_NAME:-unknown}."
  exit 1
fi

REPO_DIR="${REPO_DIR:-$(pwd)}"
MOS_REPO_URL="${MOS_REPO_URL:-https://github.com/rpuls/my-own-suite.git}"
MOS_REPO_REF="${MOS_REPO_REF:-staging}"
MOS_HOSTNAME="${MOS_HOSTNAME:-mos}"
MOS_PRIMARY_USER="${MOS_PRIMARY_USER:-mos}"
MOS_STACK_DOMAIN="${MOS_STACK_DOMAIN:-mos.home}"
MOS_PUBLIC_DOMAIN="${MOS_PUBLIC_DOMAIN:-}"
INSTALL_DOCKER="${INSTALL_DOCKER:-1}"
INSTALL_NODE="${INSTALL_NODE:-1}"
CLONE_REPO_IF_MISSING="${CLONE_REPO_IF_MISSING:-0}"
AUTO_START_STACK="${AUTO_START_STACK:-0}"

log() {
  printf '\n[%s] %s\n' "mos-selfhost" "$1"
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

configure_hostname() {
  local target_hostname="$1"

  if [[ -z "${target_hostname}" ]]; then
    return
  fi

  local current_hostname
  current_hostname="$(hostnamectl --static status 2>/dev/null || hostname)"

  if [[ "${current_hostname}" == "${target_hostname}" ]]; then
    log "Hostname already set to ${target_hostname}"
    return
  fi

  log "Setting machine hostname to ${target_hostname}"
  hostnamectl set-hostname "${target_hostname}"
}

set_env_value() {
  local file_path="$1"
  local key="$2"
  local value="$3"

  mkdir -p "$(dirname "${file_path}")"
  touch "${file_path}"

  if grep -q "^${key}=" "${file_path}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file_path}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file_path}"
  fi
}

configure_stack_domain() {
  if [[ ! -f "${REPO_DIR}/package.json" ]]; then
    return
  fi

  log "Configuring self-host stack domain"
  set_env_value "${REPO_DIR}/deploy/vps/.env" "DOMAIN" "${MOS_STACK_DOMAIN}"
}

ensure_docker_access_for_user() {
  local username="$1"

  if [[ -z "${username}" ]]; then
    return
  fi

  if ! id -u "${username}" >/dev/null 2>&1; then
    log "Skipping docker group update because user ${username} does not exist yet"
    return
  fi

  log "Granting docker access to ${username}"
  usermod -aG docker "${username}"
}

install_base_packages() {
  log "Installing base packages"
  apt-get update
  apt_install ca-certificates curl git gnupg lsb-release jq avahi-daemon
  systemctl enable --now avahi-daemon
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed"
    return
  fi

  log "Installing Docker Engine and Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    ${VERSION_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null

  apt-get update
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

install_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    log "Node.js and npm already installed"
    return
  fi

  log "Installing Node.js 22.x and npm"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt_install nodejs
}

ensure_repo_checkout() {
  if [[ -f "${REPO_DIR}/package.json" ]]; then
    log "Using existing repo checkout at ${REPO_DIR}"
    return
  fi

  if [[ "${CLONE_REPO_IF_MISSING}" != "1" ]]; then
    log "Skipping repo clone because ${REPO_DIR} is missing and CLONE_REPO_IF_MISSING is disabled"
    return
  fi

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

bootstrap_stack() {
  if [[ ! -f "${REPO_DIR}/package.json" ]]; then
    log "Skipping stack bootstrap because ${REPO_DIR} does not look like the repo root"
    return
  fi

  log "Preparing stack env files"
  (
    cd "${REPO_DIR}"
    npm run vps:init
  )

  configure_stack_domain

  (
    cd "${REPO_DIR}"
    npm run vps:doctor
  )

  log "Bootstrap complete. Start the suite with: npm run vps:up"

  if [[ "${AUTO_START_STACK}" == "1" ]]; then
    log "Starting suite stack"
    (
      cd "${REPO_DIR}"
      npm run vps:up
    )
  fi
}

print_summary() {
  log "Bootstrap summary"
  echo "Machine hostname: ${MOS_HOSTNAME}"
  echo "Local suite domain target: ${MOS_STACK_DOMAIN}"
  if [[ -n "${MOS_PUBLIC_DOMAIN}" ]]; then
    echo "Public suite domain target: mos.${MOS_PUBLIC_DOMAIN}"
  else
    echo "Public suite domain target: not configured yet"
  fi
  echo
  echo "Next steps:"
  echo "1. Point local wildcard DNS for *.${MOS_STACK_DOMAIN} to this machine if you want pretty app subdomains on the LAN."
  echo "2. Configure a wildcard public hostname for *.mos.<your-domain> if you want remote access."
  echo "3. Run 'npm run vps:up' from ${REPO_DIR} to build and start the suite."
}

log "Starting Ubuntu self-host bootstrap"
install_base_packages

if [[ "${INSTALL_DOCKER}" == "1" ]]; then
  install_docker
fi

ensure_docker_access_for_user "${MOS_PRIMARY_USER}"

if [[ "${INSTALL_NODE}" == "1" ]]; then
  install_node
fi

configure_hostname "${MOS_HOSTNAME}"
ensure_repo_checkout
bootstrap_stack
print_summary
