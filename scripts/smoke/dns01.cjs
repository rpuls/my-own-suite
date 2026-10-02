#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const smokeStatePath = path.join(repoRoot, '.mos-smoke', 'digitalocean.json');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed with status ${response.status}.`);
  return { body, response };
}

async function main() {
  if (process.env.MOS_DNS01_CONFIRM !== 'APPLY_REAL_DNS01') {
    throw new Error('Refusing real DNS-01 validation. Set MOS_DNS01_CONFIRM=APPLY_REAL_DNS01 explicitly.');
  }
  required('DIGITALOCEAN_ACCESS_TOKEN');
  const baseDomain = required('MOS_DNS01_BASE_DOMAIN');
  const acmeEmail = required('MOS_DNS01_ACME_EMAIL');
  const cloudflareApiToken = required('CLOUDFLARE_API_TOKEN');
  const ownerEmail = required('MOS_DNS01_OWNER_EMAIL');
  const ownerPassword = required('MOS_DNS01_OWNER_PASSWORD');
  if (!fs.existsSync(smokeStatePath)) throw new Error('No MOS DigitalOcean smoke state exists. Run smoke:do:reset first.');
  const state = JSON.parse(fs.readFileSync(smokeStatePath, 'utf8'));
  const suiteUrl = new URL('/suite-manager/', state.homepageUrl);
  const login = await request(new URL('api/auth/login', suiteUrl), {
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Suite Manager did not create an owner session.');
  // The change answers at once and runs on; the status says where it got to.
  const started = await request(new URL('api/settings/address/change', suiteUrl), {
    body: JSON.stringify({ acmeEmail, baseDomain, cloudflareApiToken, kind: 'domain' }),
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    method: 'POST',
  });
  process.stdout.write(`[mos-dns01] Address change started towards ${started.body.target.host}. Waiting for it to finish.\n`);
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    let status = null;
    try {
      status = (await request(new URL('api/settings/address', suiteUrl), { headers: { Cookie: cookie } })).body;
    } catch {}
    if (status?.lastChange?.status === 'failed') throw new Error(`The address change failed: ${status.lastChange.errorCode}\n${status.lastChange.diagnostics || ''}`);
    if (status?.lastChange?.status === 'applied') {
      process.stdout.write(`[mos-dns01] The suite is served at ${status.address.url}${status.address.resolvesHere === false ? ' (the name does not point at this server yet)' : ''}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Timed out waiting for the address change. Check the Settings screen through the bootstrap URL.');
}

main().catch((error) => {
  process.stderr.write(`[mos-dns01] ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
