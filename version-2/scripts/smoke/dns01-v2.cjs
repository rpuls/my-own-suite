#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const v2Root = path.resolve(__dirname, '..', '..');
const smokeStatePath = path.join(v2Root, '.mos-smoke', 'v2-digitalocean.json');

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
  if (process.env.MOS_V2_DNS01_CONFIRM !== 'APPLY_REAL_DNS01') {
    throw new Error('Refusing real DNS-01 validation. Set MOS_V2_DNS01_CONFIRM=APPLY_REAL_DNS01 explicitly.');
  }
  required('DIGITALOCEAN_ACCESS_TOKEN');
  const baseDomain = required('MOS_V2_DNS01_BASE_DOMAIN');
  const acmeEmail = required('MOS_V2_DNS01_ACME_EMAIL');
  const cloudflareApiToken = required('CLOUDFLARE_API_TOKEN');
  const ownerEmail = required('MOS_V2_DNS01_OWNER_EMAIL');
  const ownerPassword = required('MOS_V2_DNS01_OWNER_PASSWORD');
  if (!fs.existsSync(smokeStatePath)) throw new Error('No V2 DigitalOcean smoke state exists. Run smoke:do:reset first.');
  const state = JSON.parse(fs.readFileSync(smokeStatePath, 'utf8'));
  const suiteUrl = new URL('/suite-manager/', state.homepageUrl);
  const login = await request(new URL('api/auth/login', suiteUrl), {
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Suite Manager did not create an owner session.');
  const applied = await request(new URL('api/settings/https/apply', suiteUrl), {
    body: JSON.stringify({ acmeEmail, baseDomain, cloudflareApiToken }),
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    method: 'POST',
  });
  process.stdout.write(`[mos-v2-dns01] Configuration applied. Waiting for ${applied.body.homeUrl}\n`);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/suite-manager/api/setup/status', applied.body.homeUrl));
      if (response.ok) {
        process.stdout.write(`[mos-v2-dns01] HTTPS is reachable at ${applied.body.homeUrl}\n`);
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Timed out waiting for the HTTPS Home URL. Check DNS and Caddy diagnostics through the bootstrap URL.');
}

main().catch((error) => {
  process.stderr.write(`[mos-v2-dns01] ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
