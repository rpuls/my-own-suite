#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderBootstrapPlan } = require('../installers/bootstrap-contract.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const smokeDir = path.join(repoRoot, '.mos-smoke');
const logDir = path.join(smokeDir, 'logs');
const statePath = path.join(smokeDir, 'digitalocean.json');
const localEnvPath = path.join(smokeDir, 'digitalocean.env');
const smokeTag = 'mos-smoke';
const namePrefix = 'mos-smoke-';
const apiBaseUrl = 'https://api.digitalocean.com/v2';
const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000;

loadLocalEnvFile();

function usage() {
  console.log(`Usage: node scripts/smoke/digitalocean.cjs <reset|destroy|render>

Commands:
  reset    Create a fresh MOS smoke Droplet, replacing the current one if present.
  destroy  Destroy the current tagged MOS smoke Droplet from local state.
  render   Render the MOS DigitalOcean cloud-init payload without creating paid resources.

Environment:
  DIGITALOCEAN_ACCESS_TOKEN       Required for up/reset/destroy.
  MOS_SMOKE_REGION             Default: fra1.
  MOS_SMOKE_SIZE               Default: s-2vcpu-4gb.
  MOS_SMOKE_IMAGE              Default: ubuntu-24-04-x64.
  MOS_SMOKE_INSTALLER_URL      Default: https://get-dev.myownsuite.org/install.sh.
  MOS_SMOKE_DOMAIN             Optional explicit domain.
  MOS_SMOKE_WAIT               Set to 0 to skip HTTP readiness polling.
  MOS_SMOKE_SSH_KEY_ID         Optional SSH key id.
  MOS_SMOKE_SSH_KEY_FINGERPRINT Optional SSH key fingerprint.
  MOS_SMOKE_SSH_KEY_NAME       Optional SSH key name to resolve.
  MOS_SMOKE_SSH_PRIVATE_KEY    Optional private-key path used to print the owner claim URL.
`);
}

function fail(message) {
  console.error(`[mos-smoke:do] ERROR: ${message}`);
  process.exit(1);
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadLocalEnvFile() {
  if (!fs.existsSync(localEnvPath)) {
    return;
  }

  const lines = fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseEnvValue(line.slice(separatorIndex + 1));
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function compatibleEnv(name, legacyName, fallback = '') {
  return env(name, env(legacyName, fallback));
}

function requireEnv(name) {
  const value = env(name);
  if (!value) {
    fail(`Missing ${name}.`);
  }
  return value;
}

function ensureDirs() {
  fs.mkdirSync(logDir, { recursive: true });
}

function readState() {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  ensureDirs();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeState() {
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToken() {
  return requireEnv('DIGITALOCEAN_ACCESS_TOKEN');
}

async function doRequest(token, method, resourcePath, body = null) {
  const response = await fetch(`${apiBaseUrl}${resourcePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === null ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.message || payload?.id || response.statusText;
    const error = new Error(`${method} ${resourcePath} failed: ${message}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function ensureTag(token) {
  try {
    await doRequest(token, 'POST', '/tags', { name: smokeTag });
  } catch (error) {
    if (!String(error.message).includes('already exists')) {
      throw error;
    }
  }
}

async function resolveOptionalSshKeys(token) {
  const byId = compatibleEnv('MOS_SMOKE_SSH_KEY_ID', 'MOS_SMOKE_SSH_KEY_ID');
  if (byId) {
    return [Number.isNaN(Number(byId)) ? byId : Number(byId)];
  }

  const byFingerprint = compatibleEnv('MOS_SMOKE_SSH_KEY_FINGERPRINT', 'MOS_SMOKE_SSH_KEY_FINGERPRINT');
  if (byFingerprint) {
    return [byFingerprint];
  }

  const byName = compatibleEnv('MOS_SMOKE_SSH_KEY_NAME', 'MOS_SMOKE_SSH_KEY_NAME');
  if (!byName) {
    return [];
  }

  const payload = await doRequest(token, 'GET', '/account/keys?per_page=200');
  const matches = payload.ssh_keys.filter((key) => key.name === byName);
  if (matches.length !== 1) {
    fail(`Expected exactly one DigitalOcean SSH key named "${byName}", found ${matches.length}.`);
  }

  return [matches[0].id];
}

function smokeConfigFromEnv(state = {}) {
  return {
    image: env('MOS_SMOKE_IMAGE', state.image || 'ubuntu-24-04-x64'),
    region: env('MOS_SMOKE_REGION', state.region || 'fra1'),
    installerUrl: env('MOS_SMOKE_INSTALLER_URL', state.installerUrl || 'https://get-dev.myownsuite.org/install.sh'),
    size: env('MOS_SMOKE_SIZE', state.size || 's-2vcpu-4gb'),
  };
}

function renderPublicInstallerCloudInit(installerUrl) {
  const parsed = new URL(installerUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('MOS_SMOKE_INSTALLER_URL must use HTTPS.');
  }
  // pipefail matters more than it looks: without it, a failed download pipes an
  // empty stream into bash, which exits 0. The machine then sits there having
  // installed nothing, and the only symptom is a readiness timeout half an hour
  // later. With it, cloud-init records the failure in /var/log/cloud-init-output.log.
  return `#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
runcmd:
  - [ bash, -lc, "set -o pipefail; curl -fsSL --proto '=https' --tlsv1.2 '${installerUrl}' | bash" ]
`;
}

// Runs before anything paid is created. The dev installer endpoint resolves a
// branch tip through GitHub on every request, so it starts returning 503 the
// moment the branch it is pinned to is deleted — and a Droplet booted against a
// broken endpoint looks exactly like a Droplet that is still installing.
async function preflightInstaller(installerUrl, fetchImpl = fetch) {
  const endpointHelp = 'Point the dev Worker at a branch that exists and redeploy it — see infrastructure/installer-endpoint/README.md.';

  let response;
  try {
    response = await fetchImpl(installerUrl, { headers: { 'Cache-Control': 'no-cache' } });
  } catch (error) {
    throw new Error(`Could not reach the installer endpoint at ${installerUrl}: ${error.message}`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`The installer endpoint at ${installerUrl} returned ${response.status}: ${body.trim() || response.statusText}\n${endpointHelp}`);
  }

  if (!body.startsWith('#!')) {
    throw new Error(`The installer endpoint at ${installerUrl} did not return a shell script.\n${endpointHelp}`);
  }

  return {
    installBranch: response.headers.get('x-mos-install-branch') || '',
    installRef: response.headers.get('x-mos-install-ref') || '',
  };
}

function bootstrapPlanFor(config, ip = '') {
  return renderBootstrapPlan({
    domain: env('MOS_SMOKE_DOMAIN'),
    frontDoor: 'public-vps',
    publicIpv4: ip || env('MOS_SMOKE_PUBLIC_IPV4'),
    repoRef: config.repoRef,
    repoUrl: config.repoUrl,
  });
}

function ownerClaimUrl(setupUrl, token) {
  const url = new URL(setupUrl);
  url.searchParams.set('claim', token);
  return url.toString();
}

async function readOwnerClaimToken(ip) {
  const privateKey = compatibleEnv('MOS_SMOKE_SSH_PRIVATE_KEY', 'MOS_SMOKE_SSH_PRIVATE_KEY');
  if (!privateKey) {
    return '';
  }

  const deadline = Date.now() + Number(env('MOS_SMOKE_SSH_TIMEOUT_MS', '120000'));
  while (Date.now() < deadline) {
    const result = spawnSync('ssh', [
      '-i', privateKey,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      `root@${ip}`,
      "sed -n 's/^MOS_OWNER_CLAIM_TOKEN=//p' /etc/mos/secrets/owner-claim.env",
    ], { encoding: 'utf8', windowsHide: true });
    const token = String(result.stdout || '').trim();
    if (/^[a-f0-9]{64}$/.test(token)) {
      return token;
    }
    await sleep(5000);
  }

  return '';
}

function dropletPublicIpv4(droplet) {
  return droplet.networks?.v4?.find((network) => network.type === 'public')?.ip_address || '';
}

function isSmokeDroplet(droplet) {
  return droplet?.name?.startsWith(namePrefix) && Array.isArray(droplet.tags) && droplet.tags.includes(smokeTag);
}

async function getDroplet(token, dropletId) {
  try {
    const payload = await doRequest(token, 'GET', `/droplets/${dropletId}`);
    return payload.droplet;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function waitForDropletNetwork(token, dropletId) {
  const deadline = Date.now() + Number(env('MOS_SMOKE_DROPLET_TIMEOUT_MS', '600000'));

  while (Date.now() < deadline) {
    const droplet = await getDroplet(token, dropletId);
    const ip = droplet ? dropletPublicIpv4(droplet) : '';

    if (droplet?.status === 'active' && ip) {
      return { droplet, ip };
    }

    console.log(`[mos-smoke:do] Waiting for Droplet network (${droplet?.status || 'unknown'})...`);
    await sleep(10000);
  }

  fail('Timed out waiting for Droplet to become active with a public IPv4 address.');
}

async function waitForSuiteManager(plan) {
  if (env('MOS_SMOKE_WAIT', '1') === '0') {
    return;
  }

  const statusUrl = new URL('api/setup/status', plan.config.publicUrls.suiteManager).toString();
  const homeUrl = plan.config.publicUrls.home;
  const deadline = Date.now() + Number(env('MOS_SMOKE_READY_TIMEOUT_MS', String(DEFAULT_READY_TIMEOUT_MS)));

  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok) {
        const status = await response.json();
        if (status.status === 'needs-owner' || status.status === 'signed-out') {
          const homeResponse = await fetch(homeUrl, { redirect: 'manual' });
          if (homeResponse.status === 302 && homeResponse.headers.get('location') === '/suite-manager/') {
            return;
          }
        }
      }
    } catch {
      // Cloud-init is still installing or Caddy is not ready yet.
    }

    console.log('[mos-smoke:do] Waiting for Suite Manager first-run readiness...');
    await sleep(15000);
  }

  fail(`Timed out waiting for Suite Manager readiness at ${statusUrl}.
The Droplet is still running so the install can be inspected:
  ssh root@${new URL(homeUrl).hostname.replace(/^home\./u, '').replace(/\.sslip\.io$/u, '')} 'tail -n 80 /var/log/cloud-init-output.log; systemctl --failed'`);
}

async function createDroplet(token, config) {
  await ensureTag(token);
  const sshKeys = await resolveOptionalSshKeys(token);
  const name = `${namePrefix}${timestamp().slice(0, 19).toLowerCase()}`;
  const payload = await doRequest(token, 'POST', '/droplets', {
    backups: false,
    image: config.image,
    ipv6: false,
    monitoring: true,
    name,
    region: config.region,
    size: config.size,
    ssh_keys: sshKeys,
    tags: [smokeTag],
    user_data: renderPublicInstallerCloudInit(config.installerUrl),
  });

  return payload.droplet;
}

async function destroyDroplet(token, droplet, reason) {
  if (!isSmokeDroplet(droplet)) {
    fail(`Refusing to destroy Droplet ${droplet?.id || '(unknown)'} because it is not named ${namePrefix}* and tagged ${smokeTag}.`);
  }

  console.log(`[mos-smoke:do] Destroying ${droplet.name} (${droplet.id}) from ${reason}...`);
  await doRequest(token, 'DELETE', `/droplets/${droplet.id}`);
}

async function destroyExistingFromState(token, state, reason) {
  const droplet = await getDroplet(token, state.dropletId);
  if (!droplet) {
    console.log(`[mos-smoke:do] Droplet ${state.dropletId} no longer exists.`);
    removeState();
    return false;
  }

  await destroyDroplet(token, droplet, reason);
  removeState();
  return true;
}

function printSummary(state, claimUrl = '') {
  console.log(`
[mos-smoke:do] Smoke Droplet is ready.

URLs:
  MOS Home:      ${state.homepageUrl}
  Suite Manager: ${state.suiteManagerUrl}
${claimUrl ? `  Owner setup:  ${claimUrl}` : '  Owner setup:  claim URL unavailable; configure MOS_SMOKE_SSH_PRIVATE_KEY'}

Installed:
  ${state.installBranch || '(branch unreported)'} @ ${state.installRef || '(commit unreported)'}

State:
  ${path.relative(repoRoot, statePath)}

Destroy when finished:
  npm run smoke:do:destroy

Replace with a fresh MOS smoke Droplet:
  npm run smoke:do:reset
`);
}

async function reset() {
  ensureDirs();
  const existingState = readState();
  const token = getToken();
  const config = smokeConfigFromEnv(existingState || {});

  // Ahead of the destroy as well as the create: a broken endpoint should not
  // cost the Droplet that is already running.
  const { installBranch, installRef } = await preflightInstaller(config.installerUrl);
  console.log(`[mos-smoke:do] Installer endpoint is serving ${installBranch || 'its configured branch'} at ${installRef ? installRef.slice(0, 12) : 'an unreported commit'}.`);

  if (existingState) {
    await destroyExistingFromState(token, existingState, 'reset');
  }

  const droplet = await createDroplet(token, config);
  console.log(`[mos-smoke:do] Created Droplet ${droplet.name} (${droplet.id}).`);

  const { ip } = await waitForDropletNetwork(token, droplet.id);
  const plan = bootstrapPlanFor(config, ip);
  const state = {
    createdAt: new Date().toISOString(),
    domain: plan.config.domain,
    dropletId: droplet.id,
    homepageUrl: plan.config.publicUrls.homepage,
    setupUrl: plan.config.publicUrls.setup,
    image: config.image,
    // The exact snapshot this machine installed, recorded at creation time. The
    // branch moves; this is what you compare against when a smoke run misbehaves.
    installBranch,
    installerUrl: config.installerUrl,
    installRef,
    ip,
    region: config.region,
    size: config.size,
    suiteManagerUrl: plan.config.publicUrls.suiteManager,
  };

  writeState(state);
  await waitForSuiteManager(plan);
  const claimToken = await readOwnerClaimToken(ip);
  printSummary(state, claimToken ? ownerClaimUrl(state.setupUrl, claimToken) : '');
}

async function destroy() {
  const state = readState();
  if (!state) {
    console.log('[mos-smoke:do] No local MOS smoke Droplet state found.');
    return;
  }

  const token = getToken();
  await destroyExistingFromState(token, state, 'destroy command');
  console.log('[mos-smoke:do] Destroy complete.');
}

function render() {
  const config = smokeConfigFromEnv();
  const plan = bootstrapPlanFor(config);
  process.stdout.write(`${JSON.stringify({
    cloudInit: renderPublicInstallerCloudInit(config.installerUrl),
    components: plan.config.components,
    domain: plan.config.domain,
    homepageUrl: plan.config.publicUrls.homepage,
    setupUrl: plan.config.publicUrls.setup,
    note: 'Render-only MOS DigitalOcean smoke payload. No Droplet was created.',
    installerUrl: config.installerUrl,
    suiteManagerUrl: plan.config.publicUrls.suiteManager,
  }, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'render') {
    render();
    return;
  }

  if (command === 'reset') {
    await reset();
    return;
  }

  if (command === 'destroy') {
    await destroy();
    return;
  }

  throw new Error(`Unknown command: ${command}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mos-smoke:do] ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  bootstrapPlanFor,
  main,
  preflightInstaller,
  smokeConfigFromEnv,
  renderPublicInstallerCloudInit,
  ownerClaimUrl,
};
