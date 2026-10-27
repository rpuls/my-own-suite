// The Easy Door name is only correct while every component that derives or
// matches it agrees on one shape and one address, so the shape is defined once
// and asserted here against the ranges the nameserver's Corefile actually
// answers for. A name this file accepts and the Corefile refuses is a link that
// resolves to nothing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EASY_DOOR_CADDY_MARKER,
  EASY_DOOR_HOME_HOST_REGEXP,
  easyDoorBaseDomain,
  easyDoorHomeHost,
  easyDoorId,
  isEasyDoorId,
  isPrivateIPv4,
  parseEasyDoorHost,
  runCli,
} = require('../../shared/easy-door.cjs');
const { renderCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');

const ID = 'kqmzrt';
const PRIVATE = ['10.0.0.5', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.123.45', '192.168.0.1'];

test('only RFC1918 addresses get an Easy Door name', () => {
  for (const address of PRIVATE) assert.equal(isPrivateIPv4(address), true, `${address} is RFC1918`);
  // The restriction is the anti-phishing control, not tidiness: a public address
  // under the MOS name would make the zone an open redirector.
  for (const address of ['203.0.113.9', '172.15.0.1', '172.32.0.1', '192.169.1.1', '8.8.8.8', '127.0.0.1']) {
    assert.equal(isPrivateIPv4(address), false, `${address} is not RFC1918`);
    assert.equal(easyDoorBaseDomain(address, ID), null);
    assert.equal(easyDoorHomeHost(address, ID), null);
  }
  for (const address of ['', null, undefined, '192.168.1', '192.168.1.256', '192.168.01.42', 'home.mos.home']) {
    assert.equal(isPrivateIPv4(address), false);
    assert.equal(easyDoorHomeHost(address, ID), null);
  }
});

test('the name carries the address and the install id in one label, 192.168 by its last two numbers', () => {
  assert.equal(easyDoorHomeHost('192.168.1.100', ID), 'home.1-100-kqmzrt.local.myownsuite.org');
  assert.equal(easyDoorHomeHost('10.0.0.5', ID), 'home.10-0-0-5-kqmzrt.local.myownsuite.org');
  assert.equal(easyDoorBaseDomain('172.26.255.199', ID), '172-26-255-199-kqmzrt.local.myownsuite.org');
  assert.throws(() => easyDoorBaseDomain('192.168.1.100', 'KQMZRT'), /not an Easy Door id/u);
});

test('a name reads back to the address and id it was made from', () => {
  for (const address of PRIVATE) assert.deepEqual(parseEasyDoorHost(easyDoorHomeHost(address, ID)), { address, id: ID });
  assert.deepEqual(parseEasyDoorHost('seafile.10-5-abcdef.local.myownsuite.org'), { address: '192.168.10.5', id: 'abcdef' });
  for (const host of ['home.192-168-1-100.local.myownsuite.org', 'home.192-168-1-100-kqmzrt.local.myownsuite.org', 'home.mos.home', null]) {
    assert.equal(parseEasyDoorHost(host), null, `${host} is not an Easy Door name`);
  }
});

test('the id is made once, from letters nobody misreads, whoever asks first', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-easy-door-')), 'state', 'easy-door-id');
  const id = easyDoorId({ file });

  assert.equal(isEasyDoorId(id), true);
  assert.doesNotMatch(id, /[ilo0-9]/u);
  assert.equal(easyDoorId({ file }), id);
  assert.equal(fs.readFileSync(file, 'utf8'), `${id}\n`);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['easy-door-id'], 'no candidate file is left behind');

  fs.writeFileSync(file, 'not-an-id\n');
  assert.throws(() => easyDoorId({ file }), /does not hold an Easy Door id/u);
});

test('a machine without a door never makes an id', () => {
  let asked = false;
  assert.equal(easyDoorBaseDomain('203.0.113.9', () => { asked = true; return ID; }), null);
  assert.equal(asked, false);
});

test('Caddy matches exactly the home names this module makes, with any id', () => {
  const pattern = new RegExp(EASY_DOOR_HOME_HOST_REGEXP, 'u');

  for (const address of PRIVATE) {
    assert.equal(pattern.test(easyDoorHomeHost(address, ID)), true, `${address} must be matched`);
    assert.equal(pattern.test(easyDoorHomeHost(address, 'abcdef')), true, `${address} with another id must be matched`);
  }
  for (const host of [
    'home.203-0-113-9-kqmzrt.local.myownsuite.org',
    'home.172-32-0-1-kqmzrt.local.myownsuite.org',
    'home.192-168-123-45-kqmzrt.local.myownsuite.org',
    'home.192-168-123-45.local.myownsuite.org',
    'home.123-45.local.myownsuite.org',
    'home.123-45-kqmzr.local.myownsuite.org',
    'home.123-45-kqmzrl.local.myownsuite.org',
    'home.123-999-kqmzrt.local.myownsuite.org',
    'home.123-45-kqmzrt.local.myownsuite.org.evil.example.com',
    'evil.home.123-45-kqmzrt.local.myownsuite.org',
    'seafile.123-45-kqmzrt.local.myownsuite.org',
    'home.mos.home',
  ]) {
    assert.equal(pattern.test(host), false, `${host} must not be matched`);
  }
});

// The Corefile spells the label out by hand in RE2, so this runs its own
// templates over names this module makes and names it refuses.
test('the nameserver answers every name this module makes with its address, and only those', () => {
  const corefile = fs.readFileSync(path.join(__dirname, '../../infrastructure/nameserver/Corefile'), 'utf8');
  const templates = [...corefile.matchAll(/template IN (A|ANY) local\.myownsuite\.org \{([\s\S]*?)\n {4}\}/gu)].map(([, type, body]) => ({
    answer: /answer "([^"]+)"/u.exec(body)?.[1] || null,
    matches: [...body.matchAll(/match "([^"]+)"/gu)].map(([, source]) => new RegExp(source.replace(/\(\?P</gu, '(?<'), 'u')),
    type,
  }));
  const answerA = (name) => {
    for (const template of templates.filter((candidate) => candidate.type === 'A')) {
      const groups = template.matches.map((match) => match.exec(`${name}.`)).find(Boolean)?.groups;
      if (groups) return template.answer.replace(/^.* IN A /u, '').replace(/\{\{ \.Group\.(\w) \}\}/gu, (_, key) => groups[key]);
    }
    return null;
  };
  const challenge = templates.find((template) => template.answer?.includes('CNAME'));

  for (const address of PRIVATE) {
    const base = easyDoorBaseDomain(address, ID);
    assert.equal(answerA(`home.${base}`), address);
    assert.equal(answerA(`vaultwarden.${base}`), address);
    assert.equal(challenge.matches.some((match) => match.test(`_acme-challenge.${base}.`)), true, `${base} has a challenge name`);
  }
  for (const host of ['home.192-168-123-45-kqmzrt.local.myownsuite.org', 'home.203-0-113-9-kqmzrt.local.myownsuite.org', 'home.123-45-kqmzrl.local.myownsuite.org', 'home.123-45.local.myownsuite.org']) {
    assert.equal(answerA(host), null, `${host} must not resolve`);
  }
});

// A door is not an address: every LAN Caddyfile carries the Easy Door block,
// before and after a domain is applied, so the marker is a fact about the
// rendering and never a signal to read back.
test('every LAN Caddyfile carries the Easy Door, whatever address the suite is on', () => {
  assert.equal(renderCaddyfile().includes(EASY_DOOR_CADDY_MARKER), true);
  const https = renderCaddyfile({ bootstrapHost: 'home.mos.home', domain: { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com' }, suiteManagerPort: '3100' });
  assert.equal(https.includes(EASY_DOOR_CADDY_MARKER), true);
});

// The console banner prints the door for the address it is given, and an empty
// line — never an error — when there is none.
test('the CLI names the Easy Door for a private address and nothing for a public one', () => {
  assert.equal(runCli(['home-host', '192.168.123.45'], { id: ID }), 'home.123-45-kqmzrt.local.myownsuite.org');
  assert.equal(runCli(['home-host', '203.0.113.9'], { id: ID }), '');
  assert.throws(() => runCli(['nonsense']), /Unknown easy-door command/u);
});
