const DEFAULT_REPO_URL = 'https://github.com/rpuls/my-own-suite.git';
const DEFAULT_REPO_REF = 'feat/app-platform-v2-lab';
const DEFAULT_LOCAL_DOMAIN = 'localhost';
const DEFAULT_INSTALL_ROOT = '/opt/mos-v2';
const DEFAULT_STATE_ROOT = '/var/lib/mos-v2';
const DEFAULT_RUNTIME_USER = 'mos';
const CONTROL_PLANE_COMPONENTS = ['suite-manager', 'caddy', 'homepage', 'system-agent-placeholder'];
const FRONT_DOORS = ['digitalocean-smoke', 'cloud-init', 'usb-autoinstall', 'ssh-bootstrap'];

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

function publicUrlsFor(domain) {
  const suiteHost = domain === DEFAULT_LOCAL_DOMAIN ? domain : `suite-manager.${domain}`;
  const homepageHost = domain === DEFAULT_LOCAL_DOMAIN ? domain : `homepage.${domain}`;

  return {
    homepage: `http://${homepageHost}/`,
    suiteManager: `http://${suiteHost}/setup/`,
  };
}

function createBootstrapConfig(input = {}) {
  const domain = defaultDomainFor(input);

  return {
    components: [...CONTROL_PLANE_COMPONENTS],
    domain,
    frontDoor: input.frontDoor || 'ssh-bootstrap',
    installRoot: input.installRoot || DEFAULT_INSTALL_ROOT,
    noPreconfig: true,
    publicUrls: publicUrlsFor(domain),
    repoRef: normalizeRef(input.repoRef),
    repoUrl: normalizeRepoUrl(input.repoUrl),
    runtimeUser: input.runtimeUser || DEFAULT_RUNTIME_USER,
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
    ['MOS_V2_DOMAIN', config.domain],
    ['MOS_V2_INSTALL_ROOT', config.installRoot],
    ['MOS_V2_STATE_ROOT', config.stateRoot],
    ['MOS_V2_RUNTIME_USER', config.runtimeUser],
    ['MOS_V2_COMPONENTS', config.components.join(',')],
    ['MOS_V2_OWNER_SETUP', 'suite-manager-browser'],
    ['MOS_V2_APP_SELECTION', 'suite-manager-after-install'],
  ]
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n');
}

function renderBootstrapShell(config) {
  return `#!/usr/bin/env bash
set -euo pipefail

${renderBootstrapEnv(config)}
export MOS_V2_REPO_URL MOS_V2_REPO_REF MOS_V2_DOMAIN MOS_V2_INSTALL_ROOT MOS_V2_STATE_ROOT MOS_V2_RUNTIME_USER MOS_V2_COMPONENTS MOS_V2_OWNER_SETUP MOS_V2_APP_SELECTION

echo "[mos-v2] Bootstrapping MOS V2 control plane from ${config.repoUrl}#${config.repoRef}"
echo "[mos-v2] Components: ${config.components.join(', ')}"
echo "[mos-v2] Suite Manager first-run URL: ${config.publicUrls.suiteManager}"
echo "[mos-v2] Owner setup happens in Suite Manager after first boot."
echo "[mos-v2] App choices happen in Suite Manager after install."

install -d -m 0755 "$MOS_V2_INSTALL_ROOT" "$MOS_V2_STATE_ROOT"
cat > "$MOS_V2_STATE_ROOT/bootstrap-contract.env" <<'MOS_V2_BOOTSTRAP_ENV'
${renderBootstrapEnv(config)}
MOS_V2_SUITE_MANAGER_URL=${shellQuote(config.publicUrls.suiteManager)}
MOS_V2_HOMEPAGE_URL=${shellQuote(config.publicUrls.homepage)}
MOS_V2_BOOTSTRAP_STATUS='rendered-control-plane-contract'
MOS_V2_BOOTSTRAP_NOTE='Install Suite Manager, Caddy, Homepage, and host-agent placeholder only; create owner in browser.'
MOS_V2_BOOTSTRAP_ENV

echo "[mos-v2] Wrote bootstrap contract to $MOS_V2_STATE_ROOT/bootstrap-contract.env"
`;
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
  return `${renderBootstrapEnv(config)}
MOS_V2_FRONT_DOOR='usb-autoinstall'
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
