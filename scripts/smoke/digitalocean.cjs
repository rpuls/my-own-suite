#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const smokeDir = path.join(repoRoot, '.mos-smoke');
const logDir = path.join(smokeDir, 'logs');
const statePath = path.join(smokeDir, 'digitalocean.json');
const localEnvPath = path.join(smokeDir, 'digitalocean.env');
const smokeTag = 'mos-smoke';
const namePrefix = 'mos-smoke-';
const apiBaseUrl = 'https://api.digitalocean.com/v2';

const command = process.argv[2];

loadLocalEnvFile();

function usage() {
  console.log(`Usage: node scripts/smoke/digitalocean.cjs <up|destroy>

Commands:
  up       Create a tagged DigitalOcean smoke Droplet and install MOS.
  destroy  Destroy the current tagged smoke Droplet from local state.
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

function requireEnv(name) {
  const value = env(name);
  if (!value) {
    fail(`Missing ${name}.`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireOwnerConfig() {
  const email = env('MOS_SMOKE_OWNER_EMAIL');
  const password = env('MOS_SMOKE_OWNER_PASSWORD');
  const name = env('MOS_SMOKE_OWNER_NAME', 'Suite Owner');

  if (!email || !password) {
    fail('Missing MOS_SMOKE_OWNER_EMAIL or MOS_SMOKE_OWNER_PASSWORD. The current self-host installer needs temporary owner credentials.');
  }

  return { email, password, name };
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

async function resolveSshKey(token) {
  const byId = env('MOS_SMOKE_SSH_KEY_ID');
  if (byId) {
    return Number.isNaN(Number(byId)) ? byId : Number(byId);
  }

  const byFingerprint = env('MOS_SMOKE_SSH_KEY_FINGERPRINT');
  if (byFingerprint) {
    return byFingerprint;
  }

  const byName = env('MOS_SMOKE_SSH_KEY_NAME');
  if (!byName) {
    fail('Set MOS_SMOKE_SSH_KEY_ID, MOS_SMOKE_SSH_KEY_FINGERPRINT, or MOS_SMOKE_SSH_KEY_NAME.');
  }

  const payload = await doRequest(token, 'GET', '/account/keys?per_page=200');
  const matches = payload.ssh_keys.filter((key) => key.name === byName);
  if (matches.length !== 1) {
    fail(`Expected exactly one DigitalOcean SSH key named "${byName}", found ${matches.length}.`);
  }

  return matches[0].id;
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

async function listSmokeDroplets(token) {
  const payload = await doRequest(token, 'GET', `/droplets?tag_name=${encodeURIComponent(smokeTag)}&per_page=200`);
  return payload.droplets.filter(isSmokeDroplet);
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

function sshArgs(host, remoteCommand = null) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
  ];

  const privateKey = env('MOS_SMOKE_SSH_PRIVATE_KEY');
  if (privateKey) {
    args.push('-i', privateKey);
  }

  args.push(`${env('MOS_SMOKE_SSH_USER', 'root')}@${host}`);

  if (remoteCommand) {
    args.push(remoteCommand);
  }

  return args;
}

function sshCommand(ip) {
  const privateKey = env('MOS_SMOKE_SSH_PRIVATE_KEY');
  const keyArg = privateKey ? ` -i ${privateKey}` : '';
  return `ssh${keyArg} ${env('MOS_SMOKE_SSH_USER', 'root')}@${ip}`;
}

async function waitForSsh(ip) {
  const deadline = Date.now() + Number(env('MOS_SMOKE_SSH_TIMEOUT_MS', '600000'));

  while (Date.now() < deadline) {
    const result = spawnSync('ssh', sshArgs(ip, 'true'), {
      stdio: 'ignore',
    });

    if (result.status === 0) {
      return;
    }

    console.log('[mos-smoke:do] Waiting for SSH...');
    await sleep(10000);
  }

  fail('Timed out waiting for SSH readiness.');
}

function runSsh(ip, label, remoteCommand, options = {}) {
  const logPath = path.join(logDir, `${timestamp()}-${label}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const args = sshArgs(ip, remoteCommand);

  console.log(`[mos-smoke:do] Running ${label}; logging to ${path.relative(repoRoot, logPath)}`);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });

    child.on('error', (error) => {
      logStream.end();
      reject(error);
    });

    child.on('close', (code) => {
      logStream.end();
      if (code === 0) {
        resolve(logPath);
      } else {
        reject(new Error(`${label} failed with exit code ${code}. See ${logPath}.`));
      }
    });
  });
}

function installScript(config) {
  const installerUrl = env(
    'MOS_SMOKE_INSTALLER_URL',
    `https://raw.githubusercontent.com/rpuls/my-own-suite/${config.repoRef}/scripts/selfhost/install-cloud.sh`,
  );

  const exports = {
    MOS_REPO_URL: config.repoUrl,
    MOS_REPO_REF: config.repoRef,
    MOS_UPDATE_TRACK: 'branch',
    MOS_UPDATE_REF: config.repoRef,
    MOS_STACK_DOMAIN: config.domain,
    MOS_OWNER_NAME: config.owner.name,
    MOS_OWNER_EMAIL: config.owner.email,
    MOS_OWNER_PASSWORD: config.owner.password,
  };

  return `set -euo pipefail
${Object.entries(exports)
  .map(([key, value]) => `export ${key}=${shQuote(value)}`)
  .join('\n')}
curl -fsSL ${shQuote(installerUrl)} -o /tmp/mos-install-cloud.sh
sudo -E bash /tmp/mos-install-cloud.sh
`;
}

async function createDroplet(token, config) {
  await ensureTag(token);

  const sshKey = await resolveSshKey(token);
  const name = `${namePrefix}${timestamp().slice(0, 19).toLowerCase()}`;
  const payload = await doRequest(token, 'POST', '/droplets', {
    name,
    region: config.region,
    size: config.size,
    image: config.image,
    ssh_keys: [sshKey],
    backups: false,
    ipv6: false,
    monitoring: true,
    tags: [smokeTag],
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

function printSummary(state) {
  const scheme = 'http';
  console.log(`
[mos-smoke:do] Smoke Droplet is ready.

SSH:
  ${sshCommand(state.ip)}

URLs:
  Suite Manager: ${scheme}://suite-manager.${state.domain}/setup/
  Homepage:      ${scheme}://homepage.${state.domain}/

State:
  ${path.relative(repoRoot, statePath)}

Logs:
  ${path.relative(repoRoot, logDir)}

Destroy when finished:
  npm run smoke:do:destroy
`);
}

async function up() {
  ensureDirs();
  const existingState = readState();

  if (existingState && env('MOS_SMOKE_REPLACE') !== '1') {
    console.log('[mos-smoke:do] Existing smoke Droplet state found.');
    printSummary(existingState);
    fail('Refusing to create another Droplet. Set MOS_SMOKE_REPLACE=1 to destroy and replace the current smoke Droplet.');
  }

  const token = getToken();

  if (existingState && env('MOS_SMOKE_REPLACE') === '1') {
    await destroyExistingFromState(token, existingState, 'MOS_SMOKE_REPLACE=1');
  }

  const config = {
    region: env('MOS_SMOKE_REGION', 'fra1'),
    size: env('MOS_SMOKE_SIZE', 's-4vcpu-8gb'),
    image: env('MOS_SMOKE_IMAGE', 'ubuntu-24-04-x64'),
    repoRef: env('MOS_SMOKE_REPO_REF', 'staging'),
    repoUrl: env('MOS_SMOKE_REPO_URL', 'https://github.com/rpuls/my-own-suite.git'),
    owner: requireOwnerConfig(),
  };

  console.log(`[mos-smoke:do] Creating ${config.image} Droplet in ${config.region} (${config.size}) from ${config.repoRef}...`);
  const created = await createDroplet(token, config);
  let state = {
    provider: 'digitalocean',
    dropletId: created.id,
    dropletName: created.name,
    tag: smokeTag,
    region: config.region,
    size: config.size,
    image: config.image,
    repoUrl: config.repoUrl,
    repoRef: config.repoRef,
    createdAt: new Date().toISOString(),
  };
  writeState(state);

  const { droplet, ip } = await waitForDropletNetwork(token, created.id);
  const domain = env('MOS_SMOKE_DOMAIN', `${ip}.sslip.io`);
  state = { ...state, dropletName: droplet.name, ip, domain };
  writeState(state);

  console.log(`[mos-smoke:do] Droplet ${droplet.name} is active at ${ip}.`);
  console.log(`[mos-smoke:do] MOS_STACK_DOMAIN=${domain}`);
  await waitForSsh(ip);
  await runSsh(
    ip,
    'cloud-init-wait',
    'sudo cloud-init status --wait || { sudo journalctl -u cloud-init --no-pager --lines=120; exit 1; }',
  );
  await runSsh(ip, 'mos-install', 'sudo bash -s', { input: installScript({ ...config, domain }) });
  await runSsh(
    ip,
    'readiness',
    'cd /opt/my-own-suite && npm run vps:doctor && node scripts/mos-compose.cjs ps && docker ps',
  );

  printSummary(state);
}

async function destroy() {
  const token = getToken();
  const state = readState();

  if (state) {
    await destroyExistingFromState(token, state, 'local state');
    console.log('[mos-smoke:do] Destroy complete.');
    return;
  }

  const droplets = await listSmokeDroplets(token);
  if (droplets.length === 0) {
    console.log('[mos-smoke:do] No local state and no tagged smoke Droplets found.');
    return;
  }

  if (droplets.length > 1 && env('MOS_SMOKE_DESTROY_ALL_TAGGED') !== '1') {
    console.log('[mos-smoke:do] Multiple tagged smoke Droplets found:');
    for (const droplet of droplets) {
      console.log(`  ${droplet.id} ${droplet.name} ${dropletPublicIpv4(droplet)}`);
    }
    fail('Refusing tag fallback cleanup for multiple Droplets. Set MOS_SMOKE_DESTROY_ALL_TAGGED=1 to destroy all tagged smoke Droplets.');
  }

  for (const droplet of droplets) {
    await destroyDroplet(token, droplet, 'tag fallback');
  }

  console.log('[mos-smoke:do] Destroy complete.');
}

async function main() {
  if (command === 'up') {
    await up();
    return;
  }

  if (command === 'destroy') {
    await destroy();
    return;
  }

  usage();
  process.exit(command ? 1 : 0);
}

main().catch((error) => {
  fail(error.message);
});
