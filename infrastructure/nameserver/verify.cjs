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

// A private address encoded in the name resolves to itself, under any app label
// and whatever the install id is: 192.168 by its last two numbers, the rest by four.
resolves(`home.123-45-kqmzrt.${ZONE}`, '192.168.123.45');
resolves(`seafile.123-45-kqmzrt.${ZONE}`, '192.168.123.45');
resolves(`immich.123-45-abcdef.${ZONE}`, '192.168.123.45');
resolves(`123-45-kqmzrt.${ZONE}`, '192.168.123.45');
resolves(`home.10-0-0-5-kqmzrt.${ZONE}`, '10.0.0.5');
resolves(`home.10-5-kqmzrt.${ZONE}`, '192.168.10.5');
resolves(`home.172-16-4-9-kqmzrt.${ZONE}`, '172.16.4.9');
resolves(`home.172-31-255-254-zyxwvu.${ZONE}`, '172.31.255.254');

// The pre-0.23 names, without an id, until 1.0.
resolves(`home.192-168-123-45.${ZONE}`, '192.168.123.45');
resolves(`home.10-0-0-5.${ZONE}`, '10.0.0.5');
resolves(`home.172-16-4-9.${ZONE}`, '172.16.4.9');

// The anti-phishing control: a public address under the MOS name is an open
// redirector, so it must not exist. The 172 pair guards the range boundary.
refuses(`login.203-0-113-9.${ZONE}`, 'public address');
refuses(`login.8-8-8-8.${ZONE}`, 'public address');
refuses(`login.172-15-0-1.${ZONE}`, 'below the 172.16/12 range');
refuses(`login.172-32-0-1.${ZONE}`, 'above the 172.16/12 range');
refuses(`login.999-1-1-1.${ZONE}`, 'not an address');
refuses(`nothing.${ZONE}`, 'no address in the name');
refuses(`login.203-0-113-9-kqmzrt.${ZONE}`, 'public address with an id');
refuses(`login.172-32-0-1-kqmzrt.${ZONE}`, 'above the 172.16/12 range, with an id');

// One spelling per address: 192.168 is never written out in full with an id.
refuses(`home.192-168-123-45-kqmzrt.${ZONE}`, '192.168 written with four numbers');
refuses(`home.123-45-kqmzr.${ZONE}`, 'id one letter short');
refuses(`home.123-45-kqmzrtx.${ZONE}`, 'id one letter long');
refuses(`home.123-45-kqmzrl.${ZONE}`, 'id with a letter that is left out');
refuses(`home.123-45-kqm2rt.${ZONE}`, 'id with a digit');
refuses(`home.123-45.${ZONE}`, 'two numbers and no id');

// A name that exists must return NODATA for other types, never NXDOMAIN: a stub
// resolver asking AAAA alongside A would otherwise treat the whole lookup as dead.
checks.push({
  name: `AAAA home.123-45-kqmzrt.${ZONE}`,
  label: `AAAA home.123-45-kqmzrt.${ZONE} -> NODATA, not NXDOMAIN`,
  run: async () => {
    const { records, code } = await query('resolve6', `home.123-45-kqmzrt.${ZONE}`);
    if (records) return `answered ${records.join(', ')}`;
    if (code === 'ENOTFOUND') return 'returned NXDOMAIN for a name that exists';
    if (code !== 'ENODATA') return `expected NODATA, got ${code}`;
    return null;
  },
});

// The DNS-01 challenge name is a CNAME into the ACME responder's zone, for every
// query type, and never also an A record. Public addresses get no challenge name.
for (const [label, method] of [['123-45-kqmzrt', 'resolveTxt'], ['123-45-kqmzrt', 'resolve4'], ['10-0-0-5-kqmzrt', 'resolveTxt'], ['192-168-123-45', 'resolveTxt']]) {
  const name = `_acme-challenge.${label}.${ZONE}`;
  const target = `${label}.acme.myownsuite.org`;
  checks.push({
    name,
    label: `${method === 'resolveTxt' ? 'TXT' : 'A'} ${name} -> CNAME into acme.myownsuite.org`,
    run: async () => {
      const { records, code } = await query('resolveCname', name);
      if (code) return `expected a CNAME, got ${code}`;
      if (records.length !== 1 || records[0] !== target) {
        return `expected ${target}, got ${records.join(', ')}`;
      }
      if (viaResolver) return null;
      const typed = await query(method, name);
      if (typed.records && typed.records.length) return `also answered ${typed.records.join(', ')}`;
      return null;
    },
  });
}
refuses(`_acme-challenge.203-0-113-9.${ZONE}`, 'no challenge name for a public address');
refuses(`_acme-challenge.192-168-123-45-kqmzrt.${ZONE}`, 'no challenge name for a name of no valid shape');

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
