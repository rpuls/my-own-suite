'use strict';

// The one transaction that moves the suite, and the host gate around it. The
// agent, the store and the address file are all in hand here, so every stage
// and every failure between stages can be asserted directly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { SuiteAddressService, resolvesHere } = require('../src/address/suite-address-service.cjs');
const { SuiteAddressFile, addressForHost } = require('../../../shared/suite-address.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeAgent(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  return {
    calls,
    apply: record('apply', { rollbackId: 'rollback-one' }),
    commit: record('commit', { status: 'committed' }),
    discardParkedCredential: record('discardParkedCredential', { status: 'discarded' }),
    rollback: record('rollback', { status: 'rolled-back' }),
    status: record('status', { capabilities: ['cloudflare-dns01.apply'] }),
    ...overrides,
  };
}

function makeService({ address = null, agent = fakeAgent(), detectAddress = () => '192.168.30.104', rebake = async () => ({ status: 'applied' }), resolveHost = async () => [], ...rest } = {}) {
  const suiteAddress = new SuiteAddressFile({ dir: path.join(tempDir('mos-address-service-'), 'suite-address') });
  if (address) suiteAddress.write(address, { by: 'test' });
  const store = new SuiteManagerStore(tempDir('mos-address-store-'));
  let tick = 0;
  const service = new SuiteAddressService({
    agent,
    bootstrapHost: 'home.mos.home',
    detectAddress,
    frontDoor: 'ssh-bootstrap',
    now: () => new Date(Date.UTC(2026, 8, 20, 12, 0, tick++)),
    rebake,
    resolveHost,
    store,
    suiteAddress,
    ...rest,
  });
  return { agent, service, store, suiteAddress };
}

const domainInput = { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', cloudflareApiToken: 'cloudflare_token_1234567890', kind: 'domain' };

async function settled(service) {
  await service.running;
  return service.status();
}

test('the first start records the install-time name, and a later start leaves the recorded address alone', () => {
  const { service, suiteAddress } = makeService();
  assert.equal(suiteAddress.exists(), false);
  const recorded = service.start();
  assert.deepEqual({ by: recorded.by, host: recorded.host, kind: recorded.kind, scheme: recorded.scheme }, { by: 'install', host: 'home.mos.home', kind: 'lan-name', scheme: 'http' });

  service.recordDoor('home.192-168-30-104.local.myownsuite.org', { scheme: 'http' });
  assert.equal(service.start().kind, 'easy-door');

  const cloud = makeService({ bootstrapHost: 'home.203.0.113.5.sslip.io', bootstrapScheme: 'https' });
  assert.equal(cloud.service.start().scheme, 'https');
});

test('a change that was running when Suite Manager died is closed as failed on the next start', () => {
  const { service, store } = makeService();
  store.beginAddressChange({ at: 'one', target: { host: 'home.mos.example.com', kind: 'domain' } });
  service.start();
  const change = store.getAddressChange();
  assert.equal(change.status, 'failed');
  assert.equal(change.errorCode, 'ADDRESS_CHANGE_INTERRUPTED');
});

// A door is not an address: whatever is recorded, Suite Manager answers on the
// install-time name and on the live Easy Door, and on the name a change in
// flight is moving to.
test('the host gate admits the recorded address, both doors, and the target of a change in flight', () => {
  const { service, store } = makeService({ address: addressForHost('home.mos.home') });
  assert.deepEqual([...service.allowedHosts()].sort(), ['home.192-168-30-104.local.myownsuite.org', 'home.mos.home']);

  service.recordDoor('home.192-168-30-104.local.myownsuite.org', { scheme: 'http' });
  assert.deepEqual([...service.allowedHosts()].sort(), ['home.192-168-30-104.local.myownsuite.org', 'home.mos.home']);

  store.beginAddressChange({ at: 'one', target: { host: 'home.mos.example.com', kind: 'domain' } });
  assert.deepEqual([...service.allowedHosts()].sort(), ['home.192-168-30-104.local.myownsuite.org', 'home.mos.example.com', 'home.mos.home']);
  store.failAddressChange({ at: 'two', errorCode: 'X' });
  assert.equal(service.allowedHosts().has('home.mos.example.com'), false);

  const domain = makeService({ address: { acmeEmail: 'o@example.com', baseDomain: 'mos.example.com', host: 'home.mos.example.com', kind: 'domain', provider: 'cloudflare', scheme: 'https' } });
  assert.deepEqual([...domain.service.allowedHosts()].sort(), ['home.192-168-30-104.local.myownsuite.org', 'home.mos.example.com', 'home.mos.home']);

  // A public address has no Easy Door, which is what keeps cloud installs out.
  const cloud = makeService({ address: addressForHost('home.mos.home'), detectAddress: () => '203.0.113.10' });
  assert.deepEqual([...cloud.service.allowedHosts()], ['home.mos.home']);
});

test('a domain change runs its stages in order, records the address only after the web server serves it, and re-bakes the apps last', async () => {
  const order = [];
  const rebaked = [];
  // The agent answers only when the test lets it, so the state while the web
  // server is being configured can be looked at.
  let releaseAgent;
  const gate = new Promise((resolve) => { releaseAgent = resolve; });
  const agent = fakeAgent({
    apply: async (input) => { order.push(['apply', input]); await gate; return { rollbackId: 'rollback-one' }; },
    commit: async (id) => { order.push(['commit', id]); return {}; },
  });
  const { service, store, suiteAddress } = makeService({ address: addressForHost('home.mos.home'), agent, rebake: async (address) => { rebaked.push(address); order.push(['rebake']); return { status: 'applied' }; } });
  service.start();

  const started = await service.change(domainInput);
  assert.deepEqual(started, { startedAt: '2026-09-20T12:00:00.000Z', status: 'applying', target: { host: 'home.mos.example.com', kind: 'domain', scheme: 'https' } });
  assert.equal(store.getAddressChange().status, 'applying');
  assert.equal(store.getAddressChange().stage, 'caddy');
  assert.deepEqual(store.getAddressChange().target, { baseDomain: 'mos.example.com', host: 'home.mos.example.com', kind: 'domain', scheme: 'https' });
  // Nothing is recorded while the web server is still being configured.
  assert.equal(suiteAddress.read().kind, 'lan-name');
  assert.equal(service.allowedHosts().has('home.mos.example.com'), true);

  await assert.rejects(() => service.change(domainInput), (error) => error.code === 'ADDRESS_CHANGE_IN_PROGRESS' && error.statusCode === 409);

  releaseAgent();
  const status = await settled(service);
  assert.equal(status.lastChange.status, 'applied');
  assert.equal(status.lastChange.stage, 'apps');
  assert.deepEqual(status.lastChange.result, { status: 'applied' });
  assert.deepEqual(order.map((entry) => entry[0]), ['apply', 'commit', 'rebake']);
  assert.deepEqual(order[0][1], { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', bootstrapHost: 'home.mos.home', cloudflareApiToken: 'cloudflare_token_1234567890' });
  const recorded = suiteAddress.read();
  assert.deepEqual({ acmeEmail: recorded.acmeEmail, baseDomain: recorded.baseDomain, by: recorded.by, host: recorded.host, kind: recorded.kind, provider: recorded.provider, scheme: recorded.scheme },
    { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', by: 'change-suite-address', host: 'home.mos.example.com', kind: 'domain', provider: 'cloudflare', scheme: 'https' });
  // The apps are re-baked on the address as recorded, read back from the file.
  assert.equal(rebaked[0].host, 'home.mos.example.com');
  assert.equal(status.address.url, 'https://home.mos.example.com/');
  assert.equal(JSON.stringify(store.getAddressChange()).includes('cloudflare_token'), false);
});

test('an agent that refuses leaves the address untouched and records its reason without the token', async () => {
  const agent = fakeAgent({
    apply: async () => {
      throw Object.assign(new Error('Cloudflare rejected the API token.'), { code: 'CLOUDFLARE_ACCESS_DENIED', details: ['Cloudflare answered the zone lookup with HTTP 400 and error code 6003 for cloudflare_token_1234567890.'], statusCode: 400 });
    },
  });
  const rebaked = [];
  const { service, store, suiteAddress } = makeService({ address: addressForHost('home.mos.home'), agent, rebake: async () => { rebaked.push(true); } });
  service.start();
  await service.change(domainInput);
  const status = await settled(service);
  assert.equal(status.lastChange.status, 'failed');
  assert.equal(status.lastChange.stage, 'caddy');
  assert.equal(status.lastChange.errorCode, 'CLOUDFLARE_ACCESS_DENIED');
  assert.match(status.lastChange.diagnostics, /Cloudflare rejected the API token/u);
  assert.match(status.lastChange.diagnostics, /error code 6003/u);
  assert.doesNotMatch(status.lastChange.diagnostics, /cloudflare_token_1234567890/u);
  assert.equal(suiteAddress.read().host, 'home.mos.home');
  assert.deepEqual(rebaked, []);
  assert.equal(agent.calls.some(([name]) => name === 'rollback'), false, 'the agent rolled itself back before answering');
  assert.equal(store.getAddressChange().status, 'failed');

  // A finished change makes way for the next attempt.
  await service.change(domainInput);
  await service.running;
});

test('a record that cannot be written rolls the web server back, and a rebake that fails is reported on an applied change', async () => {
  const agent = fakeAgent();
  const { service, suiteAddress } = makeService({ address: addressForHost('home.mos.home'), agent });
  service.start();
  const write = suiteAddress.write.bind(suiteAddress);
  suiteAddress.write = () => { throw new Error('EACCES: permission denied'); };
  await service.change(domainInput);
  let status = await settled(service);
  assert.equal(status.lastChange.status, 'failed');
  assert.equal(status.lastChange.stage, 'recorded');
  assert.match(status.lastChange.diagnostics, /EACCES/u);
  assert.deepEqual(agent.calls.filter(([name]) => name === 'rollback'), [['rollback', 'rollback-one']]);
  assert.equal(agent.calls.some(([name]) => name === 'commit'), false);
  assert.equal(suiteAddress.read().host, 'home.mos.home');

  suiteAddress.write = write;
  const failing = makeService({ address: addressForHost('home.mos.home'), rebake: async () => { throw Object.assign(new Error('agent down'), { code: 'APP_AGENT_UNAVAILABLE' }); } });
  failing.service.start();
  await failing.service.change(domainInput);
  status = await settled(failing.service);
  // The suite is on the new address — the web server serves it and the file
  // says so — and the apps that did not follow are the reported part.
  assert.equal(status.lastChange.status, 'applied');
  assert.deepEqual(status.lastChange.result, { errorCode: 'APP_AGENT_UNAVAILABLE', skipped: false, status: 'failed' });
  assert.equal(failing.suiteAddress.read().host, 'home.mos.example.com');
});

test('an offered domain is served with the parked credential and the offer is cleared, or dismissed with its credential discarded', async () => {
  const agent = fakeAgent();
  const { service, suiteAddress } = makeService({ address: addressForHost('home.192-168-30-104.local.myownsuite.org'), agent });
  service.start();
  await assert.rejects(() => service.change({ kind: 'domain', useOffered: true }), (error) => error.code === 'NO_OFFERED_ADDRESS');

  suiteAddress.writeOffer({ acmeEmail: 'old@example.com', baseDomain: 'old.example.com', from: 'restore' });
  let status = await service.status();
  assert.deepEqual({ acmeEmail: status.offered.acmeEmail, baseDomain: status.offered.baseDomain, from: status.offered.from }, { acmeEmail: 'old@example.com', baseDomain: 'old.example.com', from: 'restore' });

  await service.change({ kind: 'domain', useOffered: true });
  status = await settled(service);
  assert.equal(status.lastChange.status, 'applied');
  assert.deepEqual(agent.calls.find(([name]) => name === 'apply')[1], { acmeEmail: 'old@example.com', baseDomain: 'old.example.com', bootstrapHost: 'home.mos.home', useParkedCredential: true });
  assert.equal(status.address.baseDomain, 'old.example.com');
  assert.equal(status.offered, null);

  // Dismissing removes the offer here and the credential at the agent.
  suiteAddress.writeOffer({ acmeEmail: null, baseDomain: 'other.example.com', from: 'restore' });
  assert.deepEqual(await service.dismissOffer(), { dismissed: true, offer: { baseDomain: 'other.example.com' } });
  assert.equal(agent.calls.filter(([name]) => name === 'discardParkedCredential').length, 1);
  assert.deepEqual(await service.dismissOffer(), { dismissed: false });
  // An offer with no contact needs one from the owner.
  suiteAddress.writeOffer({ acmeEmail: null, baseDomain: 'other.example.com', from: 'restore' });
  await assert.rejects(() => service.change({ kind: 'domain', useOffered: true }), (error) => error.code === 'INVALID_ACME_EMAIL');
  await service.change({ acmeEmail: 'me@example.com', kind: 'domain', useOffered: true });
  await service.running;
  assert.equal(suiteAddress.read().acmeEmail, 'me@example.com');
});

// A machine recorded on its Easy Door whose live name changed — DHCP gave it a
// new address — has drifted: everything published still names the old one.
// Following the door is the same transaction with no web server stage.
test('address drift is reported and following the Easy Door re-bakes without touching the web server', async () => {
  let live = '192.168.30.104';
  const agent = fakeAgent();
  const rebaked = [];
  const { service, suiteAddress } = makeService({ address: addressForHost('home.192-168-30-104.local.myownsuite.org'), agent, detectAddress: () => live, rebake: async (address) => { rebaked.push(address.host); return { status: 'applied' }; } });
  service.start();
  assert.equal((await service.status()).drifted, null);

  live = '192.168.30.120';
  let status = await service.status();
  assert.deepEqual(status.drifted, { from: 'home.192-168-30-104.local.myownsuite.org', to: 'home.192-168-30-120.local.myownsuite.org' });
  assert.equal(status.easyDoorUrl, 'http://home.192-168-30-120.local.myownsuite.org/');

  await service.change({ kind: 'easy-door' });
  status = await settled(service);
  assert.equal(status.lastChange.status, 'applied');
  assert.equal(status.drifted, null);
  assert.equal(suiteAddress.read().host, 'home.192-168-30-120.local.myownsuite.org');
  assert.deepEqual(rebaked, ['home.192-168-30-120.local.myownsuite.org']);
  assert.equal(agent.calls.some(([name]) => ['apply', 'commit', 'rollback'].includes(name)), false);

  // No drift is reported for the install-time name, and no Easy Door means no
  // Easy Door change.
  const lanName = makeService({ address: addressForHost('home.mos.home'), detectAddress: () => null });
  lanName.service.start();
  assert.equal((await lanName.service.status()).drifted, null);
  await assert.rejects(() => lanName.service.change({ kind: 'easy-door' }), (error) => error.code === 'EASY_DOOR_UNAVAILABLE');
});

test('a domain change is refused on cloud installs and with anything but the three fields', async () => {
  const cloud = makeService({ address: addressForHost('home.203.0.113.5.sslip.io', { scheme: 'https' }), detectAddress: () => '203.0.113.5', frontDoor: 'cloud-init' });
  cloud.service.start();
  await assert.rejects(() => cloud.service.change(domainInput), (error) => error.code === 'PRIVATE_HTTPS_UNAVAILABLE' && error.statusCode === 409);
  assert.equal((await cloud.service.status()).privateHttpsAvailable, false);

  const { service } = makeService({ address: addressForHost('home.mos.home') });
  service.start();
  await assert.rejects(() => service.change({ ...domainInput, extra: true }), (error) => error.code === 'INVALID_HTTPS_REQUEST');
  await assert.rejects(() => service.change({ acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', kind: 'domain' }), (error) => error.code === 'INVALID_HTTPS_REQUEST');
  await assert.rejects(() => service.change({ ...domainInput, baseDomain: 'localhost' }), (error) => error.code === 'INVALID_BASE_DOMAIN');
  await assert.rejects(() => service.change({ kind: 'raw-ip' }), (error) => error.code === 'INVALID_ADDRESS_CHANGE');
  await assert.rejects(() => service.change(null), (error) => error.code === 'INVALID_ADDRESS_CHANGE');
});

// Whether the name points here is reported, never enforced: the owner creates
// the DNS override after the certificate exists, and MOS only reads DNS.
test('status says whether a domain resolves to this machine, and says nothing for a door', async () => {
  const local = Object.values(os.networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4')?.address;
  assert.equal(await resolvesHere('home.mos.example.com', async () => [local]), Boolean(local));
  assert.equal(await resolvesHere('home.mos.example.com', async () => ['203.0.113.77']), false);
  assert.equal(await resolvesHere('home.mos.example.com', async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); }), false);
  assert.equal(await resolvesHere('home.mos.example.com', async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); }), null);

  const { service } = makeService({ address: { acmeEmail: 'o@example.com', baseDomain: 'mos.example.com', host: 'home.mos.example.com', kind: 'domain', provider: 'cloudflare', scheme: 'https' }, resolveHost: async () => ['203.0.113.77'] });
  service.start();
  const status = await service.status();
  assert.equal(status.address.resolvesHere, false);
  assert.equal(status.agentAvailable, true);
  assert.equal(status.bootstrapUrl, 'http://home.mos.home/');

  const door = makeService({ address: addressForHost('home.mos.home'), agent: fakeAgent({ status: async () => { throw new Error('down'); } }) });
  door.service.start();
  const doorStatus = await door.service.status();
  assert.equal(doorStatus.address.resolvesHere, null);
  assert.equal(doorStatus.agentAvailable, false);
});
