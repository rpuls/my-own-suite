#!/usr/bin/env node

// Acceptance checks for the ACME responder. Point it at a local test pair, at the
// Droplet, or at a public resolver to prove the whole CNAME chain end to end:
//
//   node infrastructure/acme-responder/verify.cjs 127.0.0.1:15354 --api http://127.0.0.1:8053
//   node infrastructure/acme-responder/verify.cjs <reserved-ip>
//   node infrastructure/acme-responder/verify.cjs 1.1.1.1 --via-resolver
//
// Each run posts one throwaway token for a 192.168.255.254 box. --wait-expiry
// also waits out the token's ten-minute lifetime and checks it is gone.

const crypto = require('node:crypto');
const dns = require('node:dns');

const ZONE = 'acme.myownsuite.org';
const PROBE = '192-168-255-254';
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const viaResolver = args.includes('--via-resolver');
const waitExpiry = args.includes('--wait-expiry');
const api = option('--api') || `https://${ZONE}`;
const server = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--api') || '127.0.0.1';

const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers([server]);

const query = (method, name) =>
  new Promise((resolve) => {
    resolver[method](name, (err, records) => resolve(err ? { code: err.code } : { records }));
  });

const post = (path, body) => fetch(`${api}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-User': 'mos', 'X-Api-Key': 'mos' },
  body: JSON.stringify(body),
});

const txt = crypto.randomBytes(32).toString('base64url');
const lookupName = viaResolver ? `_acme-challenge.${PROBE}.local.myownsuite.org` : `${PROBE}.${ZONE}`;

async function txtValues() {
  const { records } = await query('resolveTxt', lookupName);
  return (records || []).map((chunks) => chunks.join(''));
}

async function seenWithin(milliseconds, wanted) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if ((await txtValues()).includes(txt) === wanted) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

const checks = [
  [`SOA ${ZONE} -> answered`, async () => {
    const { code } = await query('resolveSoa', ZONE);
    return code ? `expected a SOA, got ${code}` : null;
  }],
  [`A ${ZONE} -> the box itself`, async () => {
    const { records, code } = await query('resolve4', ZONE);
    return code ? `expected an address, got ${code}` : records.length === 1 ? null : `got ${records.join(', ')}`;
  }],
  ['POST /register -> 404, registration does not exist', async () => {
    const response = await post('/register', {});
    return response.status === 404 ? null : `got ${response.status}`;
  }],
  ['POST /update for a public address -> 400', async () => {
    const response = await post('/update', { subdomain: '203-0-113-9', txt });
    return response.status === 400 ? null : `got ${response.status}`;
  }],
  ['POST /update for a private address -> 200', async () => {
    const response = await post('/update', { subdomain: PROBE, txt });
    return response.status === 200 ? null : `got ${response.status}`;
  }],
  [`TXT ${lookupName} -> the token, within seconds`, async () =>
    (await seenWithin(viaResolver ? 60000 : 15000, true)) ? null : `not seen; got ${(await txtValues()).join(', ') || 'nothing'}`],
];

if (!viaResolver) {
  checks.push(['A google.com -> refused, not resolved', async () => {
    const { records, code } = await query('resolve4', 'google.com');
    if (records) return `resolved to ${records.join(', ')}: this is an open resolver`;
    return code === 'ENOTFOUND' ? 'answered NXDOMAIN for a name it is not authoritative for' : null;
  }]);
}

if (waitExpiry) {
  checks.push(['the token is gone after its ten-minute lifetime', async () =>
    (await seenWithin(12 * 60 * 1000, false)) ? null : 'still served after twelve minutes']);
}

(async () => {
  console.log(`ACME responder checks: DNS ${server}, API ${api}\n`);
  let failed = 0;
  for (const [label, run] of checks) {
    const problem = await run().catch((error) => error.message);
    if (problem) {
      failed += 1;
      console.log(`  FAIL  ${label}\n        ${problem}`);
    } else {
      console.log(`  ok    ${label}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed) process.exit(1);
})();
