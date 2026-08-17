#!/usr/bin/env node

// Acceptance checks for the Easy Door nameserver. Point it at a local test
// container, at the Droplet directly, or at a public resolver to prove the
// delegation works end to end:
//
//   node infrastructure/nameserver/verify.cjs 127.0.0.1:15353
//   node infrastructure/nameserver/verify.cjs <reserved-ip>
//   node infrastructure/nameserver/verify.cjs 1.1.1.1 --via-resolver
//
// Pass --via-resolver when the target is a recursive resolver rather than the
// nameserver itself; the open-resolver check only means something asked directly.

const dns = require('node:dns');

const ZONE = 'local.myownsuite.org';
const args = process.argv.slice(2);
const viaResolver = args.includes('--via-resolver');
const server = args.find((arg) => !arg.startsWith('--')) || '127.0.0.1';

const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers([server]);

const query = (method, name) =>
  new Promise((resolve) => {
    resolver[method](name, (err, records) =>
      resolve(err ? { code: err.code } : { records }));
  });

const checks = [];

function resolves(name, expected) {
  checks.push({
    name,
    label: `A ${name} -> ${expected}`,
    run: async () => {
      const { records, code } = await query('resolve4', name);
      if (code) return `expected ${expected}, got ${code}`;
      if (records.length !== 1 || records[0] !== expected) {
        return `expected ${expected}, got ${records.join(', ')}`;
      }
      return null;
    },
  });
}

function refuses(name, why) {
  checks.push({
    name,
    label: `A ${name} -> no answer (${why})`,
    run: async () => {
      const { records, code } = await query('resolve4', name);
      if (records) return `answered ${records.join(', ')} but must not exist`;
      if (code !== 'ENOTFOUND') return `expected NXDOMAIN, got ${code}`;
      return null;
    },
  });
}

// A private address encoded in the name resolves to itself, under any app label.
resolves(`home.192-168-123-45.${ZONE}`, '192.168.123.45');
resolves(`seafile.192-168-123-45.${ZONE}`, '192.168.123.45');
resolves(`immich.192-168-123-45.${ZONE}`, '192.168.123.45');
resolves(`192-168-123-45.${ZONE}`, '192.168.123.45');
resolves(`home.10-0-0-5.${ZONE}`, '10.0.0.5');
resolves(`home.172-16-4-9.${ZONE}`, '172.16.4.9');
resolves(`home.172-31-255-254.${ZONE}`, '172.31.255.254');

// The anti-phishing control: a public address under the MOS name is an open
// redirector, so it must not exist. The 172 pair guards the range boundary.
refuses(`login.203-0-113-9.${ZONE}`, 'public address');
refuses(`login.8-8-8-8.${ZONE}`, 'public address');
refuses(`login.172-15-0-1.${ZONE}`, 'below the 172.16/12 range');
refuses(`login.172-32-0-1.${ZONE}`, 'above the 172.16/12 range');
refuses(`login.999-1-1-1.${ZONE}`, 'not an address');
refuses(`nothing.${ZONE}`, 'no address in the name');

// A name that exists must return NODATA for other types, never NXDOMAIN: a stub
// resolver asking AAAA alongside A would otherwise treat the whole lookup as dead.
checks.push({
  name: `AAAA home.192-168-123-45.${ZONE}`,
  label: `AAAA home.192-168-123-45.${ZONE} -> NODATA, not NXDOMAIN`,
  run: async () => {
    const { records, code } = await query('resolve6', `home.192-168-123-45.${ZONE}`);
    if (records) return `answered ${records.join(', ')}`;
    if (code === 'ENOTFOUND') return 'returned NXDOMAIN for a name that exists';
    if (code !== 'ENODATA') return `expected NODATA, got ${code}`;
    return null;
  },
});

// The zone apex answers for itself, so resolvers see a real zone rather than a hole.
checks.push({
  name: `SOA ${ZONE}`,
  label: `SOA ${ZONE} -> answered`,
  run: async () => {
    const { records, code } = await query('resolveSoa', ZONE);
    if (code) return `expected a SOA, got ${code}`;
    return records.nsname ? null : 'SOA had no primary nameserver';
  },
});

// Proves this is authoritative-only and not an open resolver.
if (!viaResolver) {
  checks.push({
    name: 'recursion',
    label: 'A google.com -> refused, not resolved',
    run: async () => {
      const { records, code } = await query('resolve4', 'google.com');
      if (records) return `resolved to ${records.join(', ')} — this is an open resolver`;
      if (code === 'ENOTFOUND') return 'answered NXDOMAIN for a name it is not authoritative for';
      return null;
    },
  });
}

(async () => {
  console.log(`Easy Door nameserver checks against ${server}\n`);

  let failed = 0;

  for (const check of checks) {
    const problem = await check.run();
    if (problem) {
      failed += 1;
      console.log(`  FAIL  ${check.label}\n        ${problem}`);
    } else {
      console.log(`  ok    ${check.label}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} passed`);

  if (failed) process.exit(1);
})();
