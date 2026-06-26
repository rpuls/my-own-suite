#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { renderBootstrapPlan } = require('../installers/bootstrap-contract.cjs');

const v2Root = path.resolve(__dirname, '..', '..');
const smokeDir = path.join(v2Root, '.mos-smoke');
const logDir = path.join(smokeDir, 'logs');
const statePath = path.join(smokeDir, 'v2-digitalocean.json');
const localEnvPath = path.join(smokeDir, 'v2-digitalocean.env');
const smokeTag = 'mos-v2-smoke';
const namePrefix = 'mos-v2-smoke-';
const apiBaseUrl = 'https://api.digitalocean.com/v2';
const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000;

loadLocalEnvFile();

function usage() {
  console.log(`Usage: node scripts/smoke/digitalocean-v2.cjs <reset|destroy|render>

Commands:
  reset    Create a fresh V2 smoke Droplet, replacing the current one if present.
  destroy  Destroy the current tagged V2 smoke Droplet from local state.
  render   Render the V2 DigitalOcean cloud-init payload without creating paid resources.

Environment:
  DIGITALOCEAN_ACCESS_TOKEN       Required for up/reset/destroy.
  MOS_V2_SMOKE_REGION             Default: fra1.
  MOS_V2_SMOKE_SIZE               Default: s-2vcpu-4gb.
  MOS_V2_SMOKE_IMAGE              Default: ubuntu-24-04-x64.
  MOS_V2_SMOKE_REPO_URL           Default: MOS GitHub repo.
  MOS_V2_SMOKE_REPO_REF           Default: feat/app-platform-v2-lab.
  MOS_V2_SMOKE_DOMAIN             Optional explicit domain.
  MOS_V2_SMOKE_WAIT               Set to 0 to skip HTTP readiness polling.
  MOS_V2_SMOKE_SSH_KEY_ID         Optional SSH key id.
  MOS_V2_SMOKE_SSH_KEY_FINGERPRINT Optional SSH key fingerprint.
  MOS_V2_SMOKE_SSH_KEY_NAME       Optional SSH key name to resolve.
`);
}

function fail(message) {
  console.error(`[mos-v2-smoke:do] ERROR: ${message}`);
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
    throw new Error(`${method} ${resourcePath} failed: ${message}`);
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
  const byId = env('MOS_V2_SMOKE_SSH_KEY_ID');
  if (byId) {
    return [Number.isNaN(Number(byId)) ? byId : Number(byId)];
  }

  const byFingerprint = env('MOS_V2_SMOKE_SSH_KEY_FINGERPRINT');
  if (byFingerprint) {
    return [byFingerprint];
  }

  const byName = env('MOS_V2_SMOKE_SSH_KEY_NAME');
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
    image: env('MOS_V2_SMOKE_IMAGE', state.image || 'ubuntu-24-04-x64'),
    region: env('MOS_V2_SMOKE_REGION', state.region || 'fra1'),
    repoRef: env('MOS_V2_SMOKE_REPO_REF', state.repoRef || 'feat/app-platform-v2-lab'),
    repoUrl: env('MOS_V2_SMOKE_REPO_URL', state.repoUrl || 'https://github.com/rpuls/my-own-suite.git'),
    size: env('MOS_V2_SMOKE_SIZE', state.size || 's-2vcpu-4gb'),
  };
}

function bootstrapPlanFor(config, ip = '') {
  return renderBootstrapPlan({
    domain: env('MOS_V2_SMOKE_DOMAIN'),
    frontDoor: 'digitalocean-smoke',
    publicIpv4: ip || env('MOS_V2_SMOKE_PUBLIC_IPV4'),
    repoRef: config.repoRef,
    repoUrl: config.repoUrl,
  });
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
    if (String(error.message).includes('not_found')) {
      return null;
    }
    throw error;
  }
}

async function waitForDropletNetwork(token, dropletId) {
  const deadline = Date.now() + Number(env('MOS_V2_SMOKE_DROPLET_TIMEOUT_MS', '600000'));

  while (Date.now() < deadline) {
    const droplet = await getDroplet(token, dropletId);
    const ip = droplet ? dropletPublicIpv4(droplet) : '';

    if (droplet?.status === 'active' && ip) {
      return { droplet, ip };
    }

    console.log(`[mos-v2-smoke:do] Waiting for Droplet network (${droplet?.status || 'unknown'})...`);
    await sleep(10000);
  }

  fail('Timed out waiting for Droplet to become active with a public IPv4 address.');
}

async function waitForSuiteManager(plan) {
  if (env('MOS_V2_SMOKE_WAIT', '1') === '0') {
    return;
  }

  const statusUrl = new URL('api/setup/status', plan.config.publicUrls.suiteManager).toString();
  const homeUrl = plan.config.publicUrls.home;
  const deadline = Date.now() + Number(env('MOS_V2_SMOKE_READY_TIMEOUT_MS', String(DEFAULT_READY_TIMEOUT_MS)));

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

    console.log('[mos-v2-smoke:do] Waiting for Suite Manager first-run readiness...');
    await sleep(15000);
  }

  fail(`Timed out waiting for Suite Manager readiness at ${statusUrl}.`);
}

async function createDroplet(token, config) {
  await ensureTag(token);
  const sshKeys = await resolveOptionalSshKeys(token);
  const name = `${namePrefix}${timestamp().slice(0, 19).toLowerCase()}`;
  const preliminaryPlan = bootstrapPlanFor(config);
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
    user_data: preliminaryPlan.cloudInit,
  });

  return payload.droplet;
}

async function destroyDroplet(token, droplet, reason) {
  if (!isSmokeDroplet(droplet)) {
    fail(`Refusing to destroy Droplet ${droplet?.id || '(unknown)'} because it is not named ${namePrefix}* and tagged ${smokeTag}.`);
  }

  console.log(`[mos-v2-smoke:do] Destroying ${droplet.name} (${droplet.id}) from ${reason}...`);
  await doRequest(token, 'DELETE', `/droplets/${droplet.id}`);
}

async function destroyExistingFromState(token, state, reason) {
  const droplet = await getDroplet(token, state.dropletId);
  if (!droplet) {
    console.log(`[mos-v2-smoke:do] Droplet ${state.dropletId} no longer exists.`);
    removeState();
    return false;
  }

  await destroyDroplet(token, droplet, reason);
  removeState();
  return true;
}

function printSummary(state) {
  console.log(`
[mos-v2-smoke:do] Smoke Droplet is ready.

URLs:
  MOS Home:      ${state.homepageUrl}
  Suite Manager: ${state.suiteManagerUrl}

State:
  ${path.relative(v2Root, statePath)}

Destroy when finished:
  npm run smoke:do:destroy

Replace with a fresh V2 smoke Droplet:
  npm run smoke:do:reset
`);
}

async function reset() {
  ensureDirs();
  const existingState = readState();

  const token = getToken();
  if (existingState) {
    await destroyExistingFromState(token, existingState, 'reset');
  }

  const config = smokeConfigFromEnv(existingState || {});
  const droplet = await createDroplet(token, config);
  console.log(`[mos-v2-smoke:do] Created Droplet ${droplet.name} (${droplet.id}).`);

  const { ip } = await waitForDropletNetwork(token, droplet.id);
  const plan = bootstrapPlanFor(config, ip);
  const state = {
    createdAt: new Date().toISOString(),
    domain: plan.config.domain,
    dropletId: droplet.id,
    homepageUrl: plan.config.publicUrls.homepage,
    setupUrl: plan.config.publicUrls.setup,
    image: config.image,
    ip,
    region: config.region,
    repoRef: config.repoRef,
    repoUrl: config.repoUrl,
    size: config.size,
    suiteManagerUrl: plan.config.publicUrls.suiteManager,
  };

  writeState(state);
  await waitForSuiteManager(plan);
  printSummary(state);
}

async function destroy() {
  const state = readState();
  if (!state) {
    console.log('[mos-v2-smoke:do] No local V2 smoke Droplet state found.');
    return;
  }

  const token = getToken();
  await destroyExistingFromState(token, state, 'destroy command');
  console.log('[mos-v2-smoke:do] Destroy complete.');
}

function render() {
  const plan = bootstrapPlanFor(smokeConfigFromEnv());
  process.stdout.write(`${JSON.stringify({
    cloudInit: plan.cloudInit,
    components: plan.config.components,
    domain: plan.config.domain,
    homepageUrl: plan.config.publicUrls.homepage,
    setupUrl: plan.config.publicUrls.setup,
    note: 'Render-only V2 DigitalOcean smoke payload. No Droplet was created.',
    repoRef: plan.config.repoRef,
    repoUrl: plan.config.repoUrl,
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
    console.error(`[mos-v2-smoke:do] ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  bootstrapPlanFor,
  main,
  smokeConfigFromEnv,
};
