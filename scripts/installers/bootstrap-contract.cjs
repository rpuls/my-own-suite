const DEFAULT_REPO_URL = 'https://github.com/rpuls/my-own-suite.git';
const DEFAULT_REPO_REF = 'staging';
const DEFAULT_LOCAL_DOMAIN = 'localhost';
const DEFAULT_INSTALL_ROOT = '/opt/mos-v2';
const DEFAULT_STATE_ROOT = '/var/lib/mos-v2';
const DEFAULT_RUNTIME_USER = 'mos';
const DEFAULT_SUITE_MANAGER_PORT = 3100;
const CONTROL_PLANE_COMPONENTS = ['suite-manager', 'caddy', 'homepage', 'https-agent', 'homepage-agent', 'app-agent', 'backup-agent', 'update-agent', 'lab-reset-agent'];
const FRONT_DOORS = ['digitalocean-smoke', 'cloud-init', 'public-vps', 'usb-autoinstall', 'ssh-bootstrap'];
const PUBLIC_CLOUD_FRONT_DOORS = ['cloud-init', 'digitalocean-smoke', 'public-vps'];

const OWNER_KEYS = [
  'ownerEmail',
  'ownerPassword',
  'ownerName',
  'MOS_OWNER_EMAIL',
  'MOS_OWNER_PASSWORD',
  'MOS_OWNER_NAME',
  'MOS_SMOKE_OWNER_EMAIL',
  'MOS_SMOKE_OWNER_PASSWORD',
  'MOS_SMOKE_OWNER_NAME',
];

const APP_KEYS = [
  'apps',
  'optionalApps',
  'selectedApps',
  'appEnv',
  'MOS_APPS',
  'MOS_SELECTED_APPS',
];

function normalizeRef(ref) {
  const value = String(ref || '').trim();
  return value || DEFAULT_REPO_REF;
}

function normalizeRepoUrl(repoUrl) {
  const value = String(repoUrl || '').trim();
  return value || DEFAULT_REPO_URL;
}

function defaultDomainFor(input = {}) {
  const explicit = String(input.domain || '').trim();
  if (explicit) {
    return explicit;
  }

  const publicIpv4 = String(input.publicIpv4 || '').trim();
  if (publicIpv4) {
    return `${publicIpv4}.sslip.io`;
  }

  return DEFAULT_LOCAL_DOMAIN;
}

function publicUrlsFor(domain, scheme = 'http') {
  const homeHost = `home.${domain}`;

  return {
    home: `${scheme}://${homeHost}/`,
    homepage: `${scheme}://${homeHost}/`,
    setup: `${scheme}://${homeHost}/suite-manager/`,
    suiteManager: `${scheme}://${homeHost}/suite-manager/`,
  };
}

function createBootstrapConfig(input = {}) {
  const domain = defaultDomainFor(input);
  const frontDoor = input.frontDoor || 'ssh-bootstrap';
  const publicScheme = PUBLIC_CLOUD_FRONT_DOORS.includes(frontDoor) ? 'https' : 'http';

  return {
    components: [...CONTROL_PLANE_COMPONENTS],
    domain,
    frontDoor,
    homepagePort: HOMEPAGE_PORT,
    installRoot: input.installRoot || DEFAULT_INSTALL_ROOT,
    noPreconfig: true,
    publicUrls: publicUrlsFor(domain, publicScheme),
    repoRef: normalizeRef(input.repoRef),
    repoUrl: normalizeRepoUrl(input.repoUrl),
    runtimeUser: input.runtimeUser || DEFAULT_RUNTIME_USER,
    suiteManagerPort: Number(input.suiteManagerPort || DEFAULT_SUITE_MANAGER_PORT),
    stateRoot: input.stateRoot || DEFAULT_STATE_ROOT,
    version: 1,
  };
}

function validateBootstrapInput(input = {}) {
  const errors = [];

  for (const key of OWNER_KEYS) {
    if (input[key]) {
      errors.push(`Owner credential input is not allowed before first boot: ${key}.`);
    }
  }

  for (const key of APP_KEYS) {
    const value = input[key];
    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      errors.push(`App selection/config input is not allowed during control-plane bootstrap: ${key}.`);
    }
  }

  if (input.frontDoor && !FRONT_DOORS.includes(input.frontDoor)) {
    errors.push(`Unknown V2 installer front door: ${input.frontDoor}.`);
  }

  return errors;
}

function assertValidBootstrapInput(input = {}) {
  const errors = validateBootstrapInput(input);
  if (errors.length > 0) {
    const error = new Error(errors.join('\n'));
    error.validationErrors = errors;
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderBootstrapEnv(config) {
  return [
    ['MOS_V2_REPO_URL', config.repoUrl],
    ['MOS_V2_REPO_REF', config.repoRef],
    ['MOS_V2_FRONT_DOOR', config.frontDoor],
    ['MOS_V2_DOMAIN', config.domain],
    ['MOS_V2_INSTALL_ROOT', config.installRoot],
    ['MOS_V2_STATE_ROOT', config.stateRoot],
    ['MOS_V2_RUNTIME_USER', config.runtimeUser],
    ['MOS_V2_SUITE_MANAGER_PORT', String(config.suiteManagerPort)],
    ['MOS_V2_HOMEPAGE_PORT', String(config.homepagePort)],
    ['MOS_V2_COMPONENTS', config.components.join(',')],
    ['MOS_V2_LAB_RESET_ENABLED', config.frontDoor === 'usb-autoinstall' ? '1' : '0'],
    ['MOS_V2_OWNER_SETUP', 'suite-manager-browser'],
    ['MOS_V2_APP_SELECTION', 'suite-manager-after-install'],
  ]
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n');
}

function renderBootstrapShell(config) {
  const cloudBootstrap = PUBLIC_CLOUD_FRONT_DOORS.includes(config.frontDoor);
  const initialScheme = cloudBootstrap ? 'https' : 'http';
  const caddyfile = cloudBootstrap ? renderPublicCloudCaddyfile() : renderCaddyfile();
  const script = `#!/usr/bin/env bash
set -euo pipefail

${renderBootstrapEnv(config)}
export MOS_V2_REPO_URL MOS_V2_REPO_REF MOS_V2_FRONT_DOOR MOS_V2_DOMAIN MOS_V2_INSTALL_ROOT MOS_V2_STATE_ROOT MOS_V2_RUNTIME_USER MOS_V2_SUITE_MANAGER_PORT MOS_V2_HOMEPAGE_PORT MOS_V2_COMPONENTS MOS_V2_LAB_RESET_ENABLED MOS_V2_OWNER_SETUP MOS_V2_APP_SELECTION

if [ "$MOS_V2_DOMAIN" = "localhost" ] && [ "$MOS_V2_FRONT_DOOR" = "digitalocean-smoke" ]; then
  metadata_ip="$(curl -fsS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)"
  if [ -n "$metadata_ip" ]; then
    MOS_V2_DOMAIN="$metadata_ip.sslip.io"
    export MOS_V2_DOMAIN
  fi
fi

if [ "$MOS_V2_DOMAIN" = "localhost" ]; then
  MOS_V2_HOME_HOST="home.localhost"
else
  MOS_V2_HOME_HOST="home.$MOS_V2_DOMAIN"
fi

MOS_V2_HOME_URL="${initialScheme}://$MOS_V2_HOME_HOST/"
MOS_V2_SETUP_URL="${initialScheme}://$MOS_V2_HOME_HOST/suite-manager/"
MOS_V2_SUITE_MANAGER_URL="$MOS_V2_SETUP_URL"
MOS_V2_HOMEPAGE_UPSTREAM="http://127.0.0.1:$MOS_V2_HOMEPAGE_PORT"
export MOS_V2_HOME_HOST MOS_V2_HOME_URL MOS_V2_SETUP_URL MOS_V2_SUITE_MANAGER_URL MOS_V2_HOMEPAGE_UPSTREAM

echo "[mos-v2] Bootstrapping MOS V2 control plane from ${config.repoUrl}#${config.repoRef}"
echo "[mos-v2] Components: ${config.components.join(', ')}"
echo "[mos-v2] MOS first-run URL: $MOS_V2_HOME_URL"
echo "[mos-v2] Suite Manager URL: $MOS_V2_SUITE_MANAGER_URL"
echo "[mos-v2] Owner setup happens in Suite Manager after first boot."
echo "[mos-v2] App choices happen in Suite Manager after install."

export DEBIAN_FRONTEND=noninteractive

if ! command -v caddy >/dev/null 2>&1; then
  rm -f /etc/apt/sources.list.d/caddy-stable.list
fi

apt-get update
apt-get install -y ca-certificates curl docker.io git gnupg ufw
systemctl enable --now docker.service
echo '[mos-v2] Pulling the pinned Homepage image while the control plane builds.'
docker pull ${shellQuote(HOMEPAGE_IMAGE)} &
homepage_pull_pid="$!"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  apt-get update
  apt-get install -y caddy
fi

if ! id -u "$MOS_V2_RUNTIME_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$MOS_V2_RUNTIME_USER"
fi

install -d -m 0755 "$MOS_V2_INSTALL_ROOT" "$MOS_V2_STATE_ROOT" "$MOS_V2_STATE_ROOT/suite-manager" "$MOS_V2_STATE_ROOT/homepage/config"
cat > "$MOS_V2_STATE_ROOT/bootstrap-contract.env" <<MOS_V2_BOOTSTRAP_ENV
${renderBootstrapEnv(config)}
MOS_V2_HOME_URL="$MOS_V2_HOME_URL"
MOS_V2_SETUP_URL="$MOS_V2_SETUP_URL"
MOS_V2_SUITE_MANAGER_URL="$MOS_V2_SUITE_MANAGER_URL"
MOS_V2_BOOTSTRAP_STATUS='installing-control-plane'
MOS_V2_BOOTSTRAP_NOTE='Install Suite Manager, Caddy, Homepage, and host-agent placeholder only; create owner in browser.'
MOS_V2_BOOTSTRAP_ENV

if [ -d "$MOS_V2_INSTALL_ROOT/repo/.git" ]; then
  git -C "$MOS_V2_INSTALL_ROOT/repo" fetch --prune origin
else
  rm -rf "$MOS_V2_INSTALL_ROOT/repo"
  git clone "$MOS_V2_REPO_URL" "$MOS_V2_INSTALL_ROOT/repo"
fi

git -C "$MOS_V2_INSTALL_ROOT/repo" checkout "$MOS_V2_REPO_REF"
git -C "$MOS_V2_INSTALL_ROOT/repo" reset --hard "$MOS_V2_REPO_REF"

npm --prefix "$MOS_V2_INSTALL_ROOT/repo" install
npm --prefix "$MOS_V2_INSTALL_ROOT/repo" run build:client

docker build --file "$MOS_V2_INSTALL_ROOT/repo/infrastructure/caddy/Dockerfile" --tag mos-v2-caddy-builder "$MOS_V2_INSTALL_ROOT/repo"
caddy_builder_container="$(docker create mos-v2-caddy-builder)"
install -d -m 0755 /usr/local/libexec/mos-v2
docker cp "$caddy_builder_container:/caddy" /usr/local/libexec/mos-v2/caddy.next
docker rm "$caddy_builder_container"
chmod 0755 /usr/local/libexec/mos-v2/caddy.next
mv /usr/local/libexec/mos-v2/caddy.next /usr/local/libexec/mos-v2/caddy
if ! /usr/local/libexec/mos-v2/caddy list-modules | grep -q '^dns.providers.cloudflare$'; then
  echo '[mos-v2] The repo-built Caddy binary is missing dns.providers.cloudflare.' >&2
  exit 1
fi

if ! getent group mos-v2-agent >/dev/null; then
  groupadd --system mos-v2-agent
fi
usermod -a -G mos-v2-agent "$MOS_V2_RUNTIME_USER"
install -d -m 0750 /etc/mos-v2 /etc/mos-v2/secrets /var/lib/mos-v2/https-agent /var/lib/mos-v2/homepage-agent "$MOS_V2_STATE_ROOT/app-packages"
if [ "$MOS_V2_FRONT_DOOR" = 'cloud-init' ] || [ "$MOS_V2_FRONT_DOOR" = 'digitalocean-smoke' ] || [ "$MOS_V2_FRONT_DOOR" = 'public-vps' ]; then
  MOS_V2_OWNER_CLAIM_TOKEN="$(openssl rand -hex 32)"
  cat > /etc/mos-v2/secrets/owner-claim.env <<MOS_V2_OWNER_CLAIM
MOS_V2_OWNER_CLAIM_TOKEN=$MOS_V2_OWNER_CLAIM_TOKEN
MOS_V2_OWNER_CLAIM
  chown root:mos-v2-agent /etc/mos-v2/secrets/owner-claim.env
  chmod 0640 /etc/mos-v2/secrets/owner-claim.env
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-https-agent
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-homepage-agent
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-app-agent
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-backup-agent
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-update-agent
install -d -m 2770 -o root -g mos-v2-agent /run/mos-v2-lab-reset-agent
install -d -m 0700 /var/lib/mos-v2/https-agent/transactions
install -d -m 0700 /var/lib/mos-v2/homepage-agent/transactions /var/lib/mos-v2/homepage-agent/history
install -d -m 0700 /var/lib/mos-v2/backup-agent
install -d -m 0700 /var/lib/mos-v2/update-agent /var/lib/mos-v2/update-agent/jobs

install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/mos-v2.conf <<'MOS_V2_CADDY_OVERRIDE'
[Service]
EnvironmentFile=-/etc/mos-v2/secrets/caddy-cloudflare.env
ExecStart=
ExecStart=/usr/local/libexec/mos-v2/caddy run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/libexec/mos-v2/caddy reload --config /etc/caddy/Caddyfile --force
MOS_V2_CADDY_OVERRIDE

homepage_seed_marker="$MOS_V2_STATE_ROOT/homepage/config/.mos-v2-defaults-v2"
for source_file in "$MOS_V2_INSTALL_ROOT/repo/infrastructure/homepage/"*; do
  target_file="$MOS_V2_STATE_ROOT/homepage/config/$(basename "$source_file")"
  if [ ! -e "$homepage_seed_marker" ] || [ ! -e "$target_file" ]; then
    cp -a "$source_file" "$target_file"
  fi
done
touch "$homepage_seed_marker"
chown -R "$MOS_V2_RUNTIME_USER:$MOS_V2_RUNTIME_USER" "$MOS_V2_STATE_ROOT"
chown -R 1000:1000 "$MOS_V2_STATE_ROOT/homepage/config"
chown -R root:root "$MOS_V2_STATE_ROOT/https-agent"
chown root:mos-v2-agent "$MOS_V2_STATE_ROOT/app-packages"
chmod 0750 "$MOS_V2_STATE_ROOT/app-packages"
chmod 0700 "$MOS_V2_STATE_ROOT/https-agent" "$MOS_V2_STATE_ROOT/https-agent/transactions"

cat > /etc/systemd/system/mos-v2-homepage.service <<MOS_V2_HOMEPAGE_UNIT
${renderHomepageSystemdUnit()}
MOS_V2_HOMEPAGE_UNIT

cat > /etc/systemd/system/mos-v2-suite-manager.service <<MOS_V2_SUITE_MANAGER_UNIT
[Unit]
Description=MOS V2 Suite Manager
After=mos-v2-homepage.service network-online.target
Wants=mos-v2-homepage.service network-online.target

[Service]
Type=simple
User=$MOS_V2_RUNTIME_USER
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_STATE_DIR=$MOS_V2_STATE_ROOT/suite-manager
Environment=MOS_V2_FRONTEND_DIST_DIR=$MOS_V2_INSTALL_ROOT/repo/suite-manager/frontend/dist
Environment=MOS_V2_SUITE_MANAGER_HOST=127.0.0.1
Environment=MOS_V2_SUITE_MANAGER_PORT=$MOS_V2_SUITE_MANAGER_PORT
Environment=MOS_V2_FRONT_DOOR=$MOS_V2_FRONT_DOOR
Environment=MOS_V2_HOME_HOST=$MOS_V2_HOME_HOST
Environment=MOS_V2_HOMEPAGE_UPSTREAM=$MOS_V2_HOMEPAGE_UPSTREAM
Environment=MOS_V2_HTTPS_AGENT_SOCKET=/run/mos-v2-https-agent/agent.sock
Environment=MOS_V2_HOMEPAGE_AGENT_SOCKET=/run/mos-v2-homepage-agent/agent.sock
Environment=MOS_V2_APP_AGENT_SOCKET=/run/mos-v2-app-agent/agent.sock
Environment=MOS_V2_APP_PACKAGE_ROOT=$MOS_V2_STATE_ROOT/app-packages
Environment=MOS_V2_BACKUP_AGENT_SOCKET=/run/mos-v2-backup-agent/agent.sock
Environment=MOS_V2_UPDATE_AGENT_SOCKET=/run/mos-v2-update-agent/agent.sock
Environment=MOS_V2_LAB_RESET_ENABLED=$MOS_V2_LAB_RESET_ENABLED
Environment=MOS_V2_LAB_RESET_AGENT_SOCKET=/run/mos-v2-lab-reset-agent/agent.sock
EnvironmentFile=-/etc/mos-v2/secrets/owner-claim.env
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/suite-manager/backend/src/server/start.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_SUITE_MANAGER_UNIT

cat > /etc/systemd/system/mos-v2-https-agent.service <<MOS_V2_HTTPS_AGENT_UNIT
[Unit]
Description=MOS V2 narrow HTTPS configuration agent
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_HTTPS_AGENT_SOCKET=/run/mos-v2-https-agent/agent.sock
Environment=MOS_V2_HTTPS_TRANSACTION_ROOT=$MOS_V2_STATE_ROOT/https-agent/transactions
Environment=MOS_V2_SUITE_MANAGER_PORT=$MOS_V2_SUITE_MANAGER_PORT
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/https/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_HTTPS_AGENT_UNIT

cat > /etc/systemd/system/mos-v2-homepage-agent.service <<MOS_V2_HOMEPAGE_AGENT_UNIT
[Unit]
Description=MOS V2 narrow Homepage configuration agent
After=network-online.target caddy.service mos-v2-homepage.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_HOMEPAGE_AGENT_SOCKET=/run/mos-v2-homepage-agent/agent.sock
Environment=MOS_V2_HOMEPAGE_CONFIG_ROOT=$MOS_V2_STATE_ROOT/homepage/config
Environment=MOS_V2_HOMEPAGE_TRANSACTION_ROOT=$MOS_V2_STATE_ROOT/homepage-agent/transactions
Environment=MOS_V2_HOMEPAGE_HISTORY_ROOT=$MOS_V2_STATE_ROOT/homepage-agent/history
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/homepage/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_HOMEPAGE_AGENT_UNIT

cat > /etc/systemd/system/mos-v2-app-agent.service <<MOS_V2_APP_AGENT_UNIT
[Unit]
Description=MOS V2 narrow app runtime agent
After=network-online.target docker.service caddy.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_APP_AGENT_SOCKET=/run/mos-v2-app-agent/agent.sock
Environment=MOS_V2_APP_PACKAGE_ROOT=$MOS_V2_STATE_ROOT/app-packages
Environment=MOS_V2_APPS_ROOT=$MOS_V2_INSTALL_ROOT/repo/apps
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/apps/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_APP_AGENT_UNIT

cat > /etc/systemd/system/mos-v2-backup-agent.service <<MOS_V2_BACKUP_AGENT_UNIT
[Unit]
Description=MOS V2 backup and restore agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_BACKUP_AGENT_SOCKET=/run/mos-v2-backup-agent/agent.sock
Environment=MOS_V2_BACKUP_AGENT_STATE_DIR=$MOS_V2_STATE_ROOT/backup-agent
Environment=MOS_V2_STATE_ROOT=$MOS_V2_STATE_ROOT
Environment=MOS_V2_STATE_DIR=$MOS_V2_STATE_ROOT/suite-manager
Environment=MOS_V2_REPO_DIR=$MOS_V2_INSTALL_ROOT/repo
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/backup/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_BACKUP_AGENT_UNIT

cat > /etc/systemd/system/mos-v2-update-agent.service <<MOS_V2_UPDATE_AGENT_UNIT
[Unit]
Description=MOS V2 managed update agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_UPDATE_AGENT_SOCKET=/run/mos-v2-update-agent/agent.sock
Environment=MOS_V2_REPO_DIR=$MOS_V2_INSTALL_ROOT/repo
Environment=MOS_V2_STATE_ROOT=$MOS_V2_STATE_ROOT
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/update/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_UPDATE_AGENT_UNIT

cat > /etc/systemd/system/mos-v2-lab-reset-agent.service <<MOS_V2_LAB_RESET_AGENT_UNIT
[Unit]
Description=MOS V2 lab reset agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-v2-agent
UMask=0007
WorkingDirectory=$MOS_V2_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_V2_LAB_RESET_AGENT_SOCKET=/run/mos-v2-lab-reset-agent/agent.sock
Environment=MOS_V2_INSTALL_ROOT=$MOS_V2_INSTALL_ROOT
Environment=MOS_V2_REPO_DIR=$MOS_V2_INSTALL_ROOT/repo
Environment=MOS_V2_STATE_ROOT=$MOS_V2_STATE_ROOT
ExecStart=/usr/bin/node $MOS_V2_INSTALL_ROOT/repo/system-agents/lab-reset/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_V2_LAB_RESET_AGENT_UNIT

cat > /etc/caddy/Caddyfile <<MOS_V2_CADDY
${caddyfile}
MOS_V2_CADDY
cat > /etc/caddy/mos-v2-homepage-routes.caddy <<'MOS_V2_HOMEPAGE_ROUTES'
# No user-managed Homepage routes.
MOS_V2_HOMEPAGE_ROUTES
cat > /etc/caddy/mos-v2-app-routes.caddy <<'MOS_V2_APP_ROUTES'
# No app runtime routes.
MOS_V2_APP_ROUTES

systemctl daemon-reload
if ! wait "$homepage_pull_pid"; then
  echo '[mos-v2] Pulling the pinned Homepage image failed.' >&2
  exit 1
fi
systemctl enable mos-v2-homepage.service
systemctl restart mos-v2-homepage.service

homepage_ready='0'
for attempt in $(seq 1 90); do
  if curl -fsS -H "Host: $MOS_V2_HOME_HOST" "$MOS_V2_HOMEPAGE_UPSTREAM" >/dev/null; then
    homepage_ready='1'
    break
  fi
  sleep 2
done
if [ "$homepage_ready" != '1' ]; then
  echo "[mos-v2] Homepage did not become ready on its private loopback endpoint." >&2
  exit 1
fi

systemctl enable mos-v2-suite-manager.service
systemctl restart mos-v2-suite-manager.service
systemctl enable caddy.service
systemctl restart caddy.service
systemctl enable mos-v2-https-agent.service
systemctl restart mos-v2-https-agent.service
systemctl enable mos-v2-homepage-agent.service
systemctl restart mos-v2-homepage-agent.service
systemctl enable mos-v2-app-agent.service
systemctl restart mos-v2-app-agent.service
systemctl enable mos-v2-backup-agent.service
systemctl restart mos-v2-backup-agent.service
systemctl enable mos-v2-update-agent.service
systemctl restart mos-v2-update-agent.service
if [ "$MOS_V2_LAB_RESET_ENABLED" = '1' ]; then
  systemctl enable mos-v2-lab-reset-agent.service
  systemctl restart mos-v2-lab-reset-agent.service
fi

cat >> "$MOS_V2_STATE_ROOT/bootstrap-contract.env" <<'MOS_V2_BOOTSTRAP_DONE'
MOS_V2_BOOTSTRAP_STATUS='ready-for-owner-setup'
MOS_V2_BOOTSTRAP_DONE

echo "[mos-v2] Wrote bootstrap contract to $MOS_V2_STATE_ROOT/bootstrap-contract.env"
echo "[mos-v2] MOS is ready for first-run owner setup at $MOS_V2_SETUP_URL"
${cloudBootstrap ? 'echo "[mos-v2] Secure one-time owner setup URL: $MOS_V2_SETUP_URL?claim=$MOS_V2_OWNER_CLAIM_TOKEN"' : ''}
`;

  return script.replace(/\r\n/g, '\n');
}

function renderCloudInit(config) {
  const indented = renderBootstrapShell(config)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');

  return `#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - git
write_files:
  - path: /usr/local/sbin/mos-v2-bootstrap-control-plane
    permissions: '0755'
    content: |
${indented}
runcmd:
  - [ bash, /usr/local/sbin/mos-v2-bootstrap-control-plane ]
`;
}

function renderSshBootstrapCommand(config) {
  return `sudo bash -s <<'MOS_V2_BOOTSTRAP'
${renderBootstrapShell(config)}
MOS_V2_BOOTSTRAP`;
}

function renderUsbSeedConfig(config) {
  const usbConfig = { ...config, frontDoor: 'usb-autoinstall' };
  return `${renderBootstrapEnv(usbConfig)}
MOS_V2_SUITE_MANAGER_URL=${shellQuote(config.publicUrls.suiteManager)}
MOS_V2_HOMEPAGE_URL=${shellQuote(config.publicUrls.homepage)}
`;
}

function renderBootstrapPlan(input = {}) {
  assertValidBootstrapInput(input);
  const config = createBootstrapConfig(input);

  return {
    cloudInit: renderCloudInit(config),
    config,
    env: renderBootstrapEnv(config),
    shell: renderBootstrapShell(config),
    sshBootstrap: renderSshBootstrapCommand(config),
    usbSeed: renderUsbSeedConfig(config),
  };
}

module.exports = {
  CONTROL_PLANE_COMPONENTS,
  DEFAULT_REPO_REF,
  DEFAULT_REPO_URL,
  FRONT_DOORS,
  createBootstrapConfig,
  defaultDomainFor,
  publicUrlsFor,
  renderBootstrapEnv,
  renderBootstrapPlan,
  renderBootstrapShell,
  renderCloudInit,
  renderSshBootstrapCommand,
  renderUsbSeedConfig,
  validateBootstrapInput,
};
const {
  HOMEPAGE_IMAGE,
  HOMEPAGE_PORT,
  renderCaddyfile,
  renderHomepageSystemdUnit,
  renderPublicCloudCaddyfile,
} = require('../../infrastructure/control-plane-runtime.cjs');
