const DEFAULT_REPO_URL = 'https://github.com/rpuls/my-own-suite.git';
const DEFAULT_REPO_REF = 'staging';
const DEFAULT_LOCAL_DOMAIN = 'localhost';
const DEFAULT_INSTALL_ROOT = '/opt/mos';
const DEFAULT_STATE_ROOT = '/var/lib/mos';
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
    disposableLab: input.disposableLab === true,
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
    errors.push(`Unknown MOS installer front door: ${input.frontDoor}.`);
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
    ['MOS_REPO_URL', config.repoUrl],
    ['MOS_REPO_REF', config.repoRef],
    ['MOS_FRONT_DOOR', config.frontDoor],
    ['MOS_DOMAIN', config.domain],
    ['MOS_INSTALL_ROOT', config.installRoot],
    ['MOS_STATE_ROOT', config.stateRoot],
    ['MOS_RUNTIME_USER', config.runtimeUser],
    ['MOS_SUITE_MANAGER_PORT', String(config.suiteManagerPort)],
    ['MOS_HOMEPAGE_PORT', String(config.homepagePort)],
    ['MOS_COMPONENTS', config.components.join(',')],
    ['MOS_DISPOSABLE_LAB', config.disposableLab ? '1' : '0'],
    ['MOS_OWNER_SETUP', 'suite-manager-browser'],
    ['MOS_APP_SELECTION', 'suite-manager-after-install'],
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
export MOS_REPO_URL MOS_REPO_REF MOS_FRONT_DOOR MOS_DOMAIN MOS_INSTALL_ROOT MOS_STATE_ROOT MOS_RUNTIME_USER MOS_SUITE_MANAGER_PORT MOS_HOMEPAGE_PORT MOS_COMPONENTS MOS_DISPOSABLE_LAB MOS_OWNER_SETUP MOS_APP_SELECTION

if [ "$MOS_DOMAIN" = "localhost" ] && [ "$MOS_FRONT_DOOR" = "digitalocean-smoke" ]; then
  metadata_ip="$(curl -fsS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)"
  if [ -n "$metadata_ip" ]; then
    MOS_DOMAIN="$metadata_ip.sslip.io"
    export MOS_DOMAIN
  fi
fi

if [ "$MOS_DOMAIN" = "localhost" ]; then
  MOS_HOME_HOST="home.localhost"
else
  MOS_HOME_HOST="home.$MOS_DOMAIN"
fi

MOS_HOME_URL="${initialScheme}://$MOS_HOME_HOST/"
MOS_SETUP_URL="${initialScheme}://$MOS_HOME_HOST/suite-manager/"
MOS_SUITE_MANAGER_URL="$MOS_SETUP_URL"
MOS_HOMEPAGE_UPSTREAM="http://127.0.0.1:$MOS_HOMEPAGE_PORT"
export MOS_HOME_HOST MOS_HOME_URL MOS_SETUP_URL MOS_SUITE_MANAGER_URL MOS_HOMEPAGE_UPSTREAM

echo "[mos] Bootstrapping MOS control plane from ${config.repoUrl}#${config.repoRef}"
echo "[mos] Components: ${config.components.join(', ')}"
echo "[mos] MOS first-run URL: $MOS_HOME_URL"
echo "[mos] Suite Manager URL: $MOS_SUITE_MANAGER_URL"
echo "[mos] Owner setup happens in Suite Manager after first boot."
echo "[mos] App choices happen in Suite Manager after install."

export DEBIAN_FRONTEND=noninteractive

if ! command -v caddy >/dev/null 2>&1; then
  rm -f /etc/apt/sources.list.d/caddy-stable.list
fi

apt-get update
apt-get install -y ca-certificates curl docker.io git gnupg ufw
systemctl enable --now docker.service
echo '[mos] Pulling the pinned Homepage image while the control plane builds.'
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

if ! id -u "$MOS_RUNTIME_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$MOS_RUNTIME_USER"
fi

install -d -m 0755 "$MOS_INSTALL_ROOT" "$MOS_STATE_ROOT" "$MOS_STATE_ROOT/suite-manager" "$MOS_STATE_ROOT/homepage/config"
cat > "$MOS_STATE_ROOT/bootstrap-contract.env" <<MOS_BOOTSTRAP_ENV
${renderBootstrapEnv(config)}
MOS_HOME_URL="$MOS_HOME_URL"
MOS_SETUP_URL="$MOS_SETUP_URL"
MOS_SUITE_MANAGER_URL="$MOS_SUITE_MANAGER_URL"
MOS_BOOTSTRAP_STATUS='installing-control-plane'
MOS_BOOTSTRAP_NOTE='Install Suite Manager, Caddy, Homepage, and host-agent placeholder only; create owner in browser.'
MOS_BOOTSTRAP_ENV

if [ -d "$MOS_INSTALL_ROOT/repo/.git" ]; then
  git -C "$MOS_INSTALL_ROOT/repo" fetch --prune origin
else
  rm -rf "$MOS_INSTALL_ROOT/repo"
  git clone "$MOS_REPO_URL" "$MOS_INSTALL_ROOT/repo"
fi

git -C "$MOS_INSTALL_ROOT/repo" checkout "$MOS_REPO_REF"
git -C "$MOS_INSTALL_ROOT/repo" reset --hard "$MOS_REPO_REF"

npm --prefix "$MOS_INSTALL_ROOT/repo" ci
npm --prefix "$MOS_INSTALL_ROOT/repo" run build:client

docker build --file "$MOS_INSTALL_ROOT/repo/infrastructure/caddy/Dockerfile" --tag mos-caddy-builder "$MOS_INSTALL_ROOT/repo"
caddy_builder_container="$(docker create mos-caddy-builder)"
install -d -m 0755 /usr/local/libexec/mos
docker cp "$caddy_builder_container:/caddy" /usr/local/libexec/mos/caddy.next
docker rm "$caddy_builder_container"
chmod 0755 /usr/local/libexec/mos/caddy.next
mv /usr/local/libexec/mos/caddy.next /usr/local/libexec/mos/caddy
if ! /usr/local/libexec/mos/caddy list-modules | grep -q '^dns.providers.cloudflare$'; then
  echo '[mos] The repo-built Caddy binary is missing dns.providers.cloudflare.' >&2
  exit 1
fi

if ! getent group mos-agent >/dev/null; then
  groupadd --system mos-agent
fi
usermod -a -G mos-agent "$MOS_RUNTIME_USER"
install -d -m 0750 /etc/mos /etc/mos/secrets /var/lib/mos/https-agent /var/lib/mos/homepage-agent "$MOS_STATE_ROOT/app-packages"
if [ "$MOS_FRONT_DOOR" = 'cloud-init' ] || [ "$MOS_FRONT_DOOR" = 'digitalocean-smoke' ] || [ "$MOS_FRONT_DOOR" = 'public-vps' ]; then
  MOS_OWNER_CLAIM_TOKEN="$(openssl rand -hex 32)"
  cat > /etc/mos/secrets/owner-claim.env <<MOS_OWNER_CLAIM
MOS_OWNER_CLAIM_TOKEN=$MOS_OWNER_CLAIM_TOKEN
MOS_OWNER_CLAIM
  chown root:mos-agent /etc/mos/secrets/owner-claim.env
  chmod 0640 /etc/mos/secrets/owner-claim.env
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
install -d -m 2770 -o root -g mos-agent /run/mos-https-agent
install -d -m 2770 -o root -g mos-agent /run/mos-homepage-agent
install -d -m 2770 -o root -g mos-agent /run/mos-app-agent
install -d -m 2770 -o root -g mos-agent /run/mos-backup-agent
install -d -m 2770 -o root -g mos-agent /run/mos-update-agent
install -d -m 2770 -o root -g mos-agent /run/mos-lab-reset-agent
install -d -m 0700 /var/lib/mos/https-agent/transactions
install -d -m 0700 /var/lib/mos/homepage-agent/transactions /var/lib/mos/homepage-agent/history
install -d -m 0700 /var/lib/mos/backup-agent
install -d -m 0700 /var/lib/mos/update-agent /var/lib/mos/update-agent/jobs

install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/mos.conf <<'MOS_CADDY_OVERRIDE'
[Service]
EnvironmentFile=-/etc/mos/secrets/caddy-cloudflare.env
ExecStart=
ExecStart=/usr/local/libexec/mos/caddy run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/libexec/mos/caddy reload --config /etc/caddy/Caddyfile --force
MOS_CADDY_OVERRIDE

homepage_seed_marker="$MOS_STATE_ROOT/homepage/config/.mos-defaults"
for source_file in "$MOS_INSTALL_ROOT/repo/infrastructure/homepage/"*; do
  target_file="$MOS_STATE_ROOT/homepage/config/$(basename "$source_file")"
  if [ ! -e "$homepage_seed_marker" ] || [ ! -e "$target_file" ]; then
    cp -a "$source_file" "$target_file"
  fi
done
touch "$homepage_seed_marker"
chown -R "$MOS_RUNTIME_USER:$MOS_RUNTIME_USER" "$MOS_STATE_ROOT"
chown -R 1000:1000 "$MOS_STATE_ROOT/homepage/config"
chown -R root:root "$MOS_STATE_ROOT/https-agent"
chown root:mos-agent "$MOS_STATE_ROOT/app-packages"
# Setgid: snapshots the root app agent writes here must inherit mos-agent so
# Suite Manager can read them back. Applied after chown, which can clear it.
chmod 2750 "$MOS_STATE_ROOT/app-packages"
chmod 0700 "$MOS_STATE_ROOT/https-agent" "$MOS_STATE_ROOT/https-agent/transactions"

cat > /etc/systemd/system/mos-homepage.service <<MOS_HOMEPAGE_UNIT
${renderHomepageSystemdUnit()}
MOS_HOMEPAGE_UNIT

cat > /etc/systemd/system/mos-suite-manager.service <<MOS_SUITE_MANAGER_UNIT
[Unit]
Description=MOS Suite Manager
After=mos-homepage.service network-online.target
Wants=mos-homepage.service network-online.target

[Service]
Type=simple
User=$MOS_RUNTIME_USER
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_STATE_DIR=$MOS_STATE_ROOT/suite-manager
Environment=MOS_FRONTEND_DIST_DIR=$MOS_INSTALL_ROOT/repo/suite-manager/frontend/dist
Environment=MOS_SUITE_MANAGER_HOST=127.0.0.1
Environment=MOS_SUITE_MANAGER_PORT=$MOS_SUITE_MANAGER_PORT
Environment=MOS_FRONT_DOOR=$MOS_FRONT_DOOR
Environment=MOS_HOME_HOST=$MOS_HOME_HOST
Environment=MOS_HOMEPAGE_UPSTREAM=$MOS_HOMEPAGE_UPSTREAM
Environment=MOS_HTTPS_AGENT_SOCKET=/run/mos-https-agent/agent.sock
Environment=MOS_HOMEPAGE_AGENT_SOCKET=/run/mos-homepage-agent/agent.sock
Environment=MOS_APP_AGENT_SOCKET=/run/mos-app-agent/agent.sock
Environment=MOS_APP_PACKAGE_ROOT=$MOS_STATE_ROOT/app-packages
Environment=MOS_BACKUP_AGENT_SOCKET=/run/mos-backup-agent/agent.sock
Environment=MOS_UPDATE_AGENT_SOCKET=/run/mos-update-agent/agent.sock
Environment=MOS_DISPOSABLE_LAB=$MOS_DISPOSABLE_LAB
Environment=MOS_LAB_RESET_AGENT_SOCKET=/run/mos-lab-reset-agent/agent.sock
EnvironmentFile=-/etc/mos/secrets/owner-claim.env
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/suite-manager/backend/src/server/start.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_SUITE_MANAGER_UNIT

cat > /etc/systemd/system/mos-https-agent.service <<MOS_HTTPS_AGENT_UNIT
[Unit]
Description=MOS narrow HTTPS configuration agent
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_HTTPS_AGENT_SOCKET=/run/mos-https-agent/agent.sock
Environment=MOS_HTTPS_TRANSACTION_ROOT=$MOS_STATE_ROOT/https-agent/transactions
Environment=MOS_SUITE_MANAGER_PORT=$MOS_SUITE_MANAGER_PORT
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/https/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_HTTPS_AGENT_UNIT

cat > /etc/systemd/system/mos-homepage-agent.service <<MOS_HOMEPAGE_AGENT_UNIT
[Unit]
Description=MOS narrow Homepage configuration agent
After=network-online.target caddy.service mos-homepage.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_HOMEPAGE_AGENT_SOCKET=/run/mos-homepage-agent/agent.sock
Environment=MOS_HOMEPAGE_CONFIG_ROOT=$MOS_STATE_ROOT/homepage/config
Environment=MOS_HOMEPAGE_TRANSACTION_ROOT=$MOS_STATE_ROOT/homepage-agent/transactions
Environment=MOS_HOMEPAGE_HISTORY_ROOT=$MOS_STATE_ROOT/homepage-agent/history
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/homepage/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_HOMEPAGE_AGENT_UNIT

cat > /etc/systemd/system/mos-app-agent.service <<MOS_APP_AGENT_UNIT
[Unit]
Description=MOS narrow app runtime agent
After=network-online.target docker.service caddy.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_APP_AGENT_SOCKET=/run/mos-app-agent/agent.sock
Environment=MOS_APP_PACKAGE_ROOT=$MOS_STATE_ROOT/app-packages
Environment=MOS_APPS_ROOT=$MOS_INSTALL_ROOT/repo/apps
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/apps/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_APP_AGENT_UNIT

cat > /etc/systemd/system/mos-backup-agent.service <<MOS_BACKUP_AGENT_UNIT
[Unit]
Description=MOS backup and restore agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_BACKUP_AGENT_SOCKET=/run/mos-backup-agent/agent.sock
Environment=MOS_BACKUP_AGENT_STATE_DIR=$MOS_STATE_ROOT/backup-agent
Environment=MOS_STATE_ROOT=$MOS_STATE_ROOT
Environment=MOS_STATE_DIR=$MOS_STATE_ROOT/suite-manager
Environment=MOS_REPO_DIR=$MOS_INSTALL_ROOT/repo
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/backup/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_BACKUP_AGENT_UNIT

cat > /etc/systemd/system/mos-update-agent.service <<MOS_UPDATE_AGENT_UNIT
[Unit]
Description=MOS managed update agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_UPDATE_AGENT_SOCKET=/run/mos-update-agent/agent.sock
Environment=MOS_REPO_DIR=$MOS_INSTALL_ROOT/repo
Environment=MOS_STATE_ROOT=$MOS_STATE_ROOT
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/update/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_UPDATE_AGENT_UNIT

cat > /etc/systemd/system/mos-lab-reset-agent.service <<MOS_LAB_RESET_AGENT_UNIT
[Unit]
Description=MOS lab reset agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=$MOS_INSTALL_ROOT/repo
Environment=NODE_ENV=production
Environment=MOS_LAB_RESET_AGENT_SOCKET=/run/mos-lab-reset-agent/agent.sock
Environment=MOS_INSTALL_ROOT=$MOS_INSTALL_ROOT
Environment=MOS_REPO_DIR=$MOS_INSTALL_ROOT/repo
Environment=MOS_STATE_ROOT=$MOS_STATE_ROOT
ExecStart=/usr/bin/node $MOS_INSTALL_ROOT/repo/system-agents/lab-reset/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
MOS_LAB_RESET_AGENT_UNIT

cat > /etc/caddy/Caddyfile <<MOS_CADDY
${caddyfile}
MOS_CADDY
cat > /etc/caddy/mos-homepage-routes.caddy <<'MOS_HOMEPAGE_ROUTES'
# No user-managed Homepage routes.
MOS_HOMEPAGE_ROUTES
cat > /etc/caddy/mos-app-routes.caddy <<'MOS_APP_ROUTES'
# No app runtime routes.
MOS_APP_ROUTES

systemctl daemon-reload
if ! wait "$homepage_pull_pid"; then
  echo '[mos] Pulling the pinned Homepage image failed.' >&2
  exit 1
fi
systemctl enable mos-homepage.service
systemctl restart mos-homepage.service

homepage_ready='0'
for attempt in $(seq 1 90); do
  if curl -fsS -H "Host: $MOS_HOME_HOST" "$MOS_HOMEPAGE_UPSTREAM" >/dev/null; then
    homepage_ready='1'
    break
  fi
  sleep 2
done
if [ "$homepage_ready" != '1' ]; then
  echo "[mos] Homepage did not become ready on its private loopback endpoint." >&2
  exit 1
fi

systemctl enable mos-suite-manager.service
systemctl restart mos-suite-manager.service
systemctl enable caddy.service
systemctl restart caddy.service
systemctl enable mos-https-agent.service
systemctl restart mos-https-agent.service
systemctl enable mos-homepage-agent.service
systemctl restart mos-homepage-agent.service
systemctl enable mos-app-agent.service
systemctl restart mos-app-agent.service
systemctl enable mos-backup-agent.service
systemctl restart mos-backup-agent.service
systemctl enable mos-update-agent.service
systemctl restart mos-update-agent.service
if [ "$MOS_DISPOSABLE_LAB" = '1' ]; then
  systemctl enable mos-lab-reset-agent.service
  systemctl restart mos-lab-reset-agent.service
fi

cat >> "$MOS_STATE_ROOT/bootstrap-contract.env" <<'MOS_BOOTSTRAP_DONE'
MOS_BOOTSTRAP_STATUS='ready-for-owner-setup'
MOS_BOOTSTRAP_DONE

echo "[mos] Wrote bootstrap contract to $MOS_STATE_ROOT/bootstrap-contract.env"
echo "[mos] MOS is ready for first-run owner setup at $MOS_SETUP_URL"

${cloudBootstrap
  ? `mos_setup_url="$MOS_SETUP_URL?claim=$MOS_OWNER_CLAIM_TOKEN"
mos_setup_note="This link carries a one-time owner setup key — open it now, create your account, then it stops working. Keep it private."`
  : `mos_setup_url="$MOS_SETUP_URL"
mos_setup_note="Open it to create your owner account and finish first-run setup."
mos_lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
[ -n "$mos_lan_ip" ] || mos_lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"`}

if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  B=$'\\033[1m'; D=$'\\033[2m'; G=$'\\033[32m'; C=$'\\033[36m'; Y=$'\\033[33m'; R=$'\\033[0m'
else
  B=''; D=''; G=''; C=''; Y=''; R=''
fi

printf '\\n\\n'
printf '%s\\n' "\${G}      ███╗   ███╗  ██████╗  ███████╗\${R}"
printf '%s\\n' "\${G}      ████╗ ████║ ██╔═══██╗ ██╔════╝\${R}"
printf '%s\\n' "\${G}      ██╔████╔██║ ██║   ██║ ███████╗\${R}"
printf '%s\\n' "\${G}      ██║╚██╔╝██║ ██║   ██║ ╚════██║\${R}"
printf '%s\\n' "\${G}      ██║ ╚═╝ ██║ ╚██████╔╝ ███████║\${R}"
printf '%s\\n' "\${G}      ╚═╝     ╚═╝  ╚═════╝  ╚══════╝\${R}"
printf '\\n'
printf '%s\\n' "   \${G}\${B}✓  Installation complete\${R}   \${D}My Own Suite is up and running.\${R}"
printf '\\n'
printf '%s\\n' "   \${D}──────────────────────────────────────────────────────────────\${R}"
printf '\\n'
printf '%s\\n' "   \${B}Finish setup — open this link in your browser:\${R}"
printf '\\n'
printf '%s\\n' "      \${C}\${B}\${mos_setup_url}\${R}"
printf '\\n'
printf '%s\\n' "   \${Y}▸\${R}  \${mos_setup_note}"
printf '\\n'
printf '%s\\n' "   \${D}Server\${R}   \${MOS_DOMAIN}"
printf '%s\\n' "   \${D}Home\${R}     \${MOS_HOME_URL}"
if [ -n "\${mos_lan_ip:-}" ]; then
  printf '%s\\n' "   \${D}LAN IP\${R}   \${mos_lan_ip}"
  printf '\\n'
  printf '%s\\n' "   \${Y}▸\${R}  If the link does not open, add a DNS override in your router or"
  printf '%s\\n' "      local DNS pointing \${B}*.\${MOS_DOMAIN}\${R} to \${B}\${mos_lan_ip}\${R}, then reload the page."
fi
printf '\\n'
printf '%s\\n' "   \${D}──────────────────────────────────────────────────────────────\${R}"
printf '\\n\\n'
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
  - path: /usr/local/sbin/mos-bootstrap-control-plane
    permissions: '0755'
    content: |
${indented}
runcmd:
  - [ bash, /usr/local/sbin/mos-bootstrap-control-plane ]
`;
}

function renderSshBootstrapCommand(config) {
  return `sudo bash -s <<'MOS_BOOTSTRAP'
${renderBootstrapShell(config)}
MOS_BOOTSTRAP`;
}

function renderUsbSeedConfig(config) {
  const usbConfig = { ...config, frontDoor: 'usb-autoinstall' };
  return `${renderBootstrapEnv(usbConfig)}
MOS_SUITE_MANAGER_URL=${shellQuote(config.publicUrls.suiteManager)}
MOS_HOMEPAGE_URL=${shellQuote(config.publicUrls.homepage)}
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
