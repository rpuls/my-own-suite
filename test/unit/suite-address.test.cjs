// The suite has one recorded address. These pin the shape of the file, the two
// kinds of door a request records, and the rule that an offer is a separate
// file the restore writes and the address is one it never touches.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SuiteAddressError,
  SuiteAddressFile,
  addressForHost,
  baseHostOf,
  domainAddress,
  suiteAddressDir,
} = require('../../shared/suite-address.cjs');
const { managedStateTargets } = require('../../infrastructure/persistent-state.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-suite-address-'));
}

test('a request records the door it came through: the Easy Door by shape, anything else as the install-time name', () => {
  assert.deepEqual(addressForHost('home.192-168-30-104.local.myownsuite.org'), { host: 'home.192-168-30-104.local.myownsuite.org', kind: 'easy-door', scheme: 'http' });
  assert.deepEqual(addressForHost('HOME.MOS.HOME:3100'), { host: 'home.mos.home', kind: 'lan-name', scheme: 'http' });
  assert.deepEqual(addressForHost('home.203.0.113.5.sslip.io', { scheme: 'https' }), { host: 'home.203.0.113.5.sslip.io', kind: 'lan-name', scheme: 'https' });
  // A public address shaped like the door is not the door: the nameserver would never answer it.
  assert.equal(addressForHost('home.203-0-113-5.local.myownsuite.org').kind, 'lan-name');
  assert.throws(() => addressForHost(''), (error) => error instanceof SuiteAddressError && error.code === 'SUITE_ADDRESS_INVALID_HOST');
  assert.throws(() => addressForHost('not a host'), SuiteAddressError);
});

test('a domain address is https on home.<domain> and carries what the domain module needs', () => {
  assert.deepEqual(domainAddress({ acmeEmail: 'Owner@Example.com', baseDomain: 'MOS.Example.com.', provider: 'cloudflare' }), {
    acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', host: 'home.mos.example.com', kind: 'domain', provider: 'cloudflare', scheme: 'https',
  });
  assert.throws(() => domainAddress({ baseDomain: 'localhost' }), SuiteAddressError);
});

test('the base every app hangs under is the host without its home label', () => {
  assert.equal(baseHostOf({ host: 'home.mos.home' }), 'mos.home');
  assert.equal(baseHostOf({ host: 'home.192-168-30-104.local.myownsuite.org' }), '192-168-30-104.local.myownsuite.org');
  assert.equal(baseHostOf({ host: '127.0.0.1' }), '127.0.0.1');
});

test('the file round-trips, refuses to be read before it exists, and rejects a broken record', () => {
  const file = new SuiteAddressFile({ dir: path.join(tempDir(), 'suite-address') });
  assert.equal(file.exists(), false);
  assert.throws(() => file.read(), (error) => error.code === 'SUITE_ADDRESS_MISSING' && error.statusCode === 503);
  assert.equal(file.readOrNull(), null);

  const written = file.write(addressForHost('home.mos.home'), { at: '2026-09-20T10:00:00.000Z', by: 'install' });
  assert.deepEqual(written, { by: 'install', host: 'home.mos.home', kind: 'lan-name', recordedAt: '2026-09-20T10:00:00.000Z', scheme: 'http' });
  assert.deepEqual(file.read(), written);
  assert.equal((fs.statSync(file.addressPath).mode & 0o777) <= 0o644 || process.platform === 'win32', true);

  file.write(domainAddress({ acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', provider: 'cloudflare' }), { at: '2026-09-20T11:00:00.000Z', by: 'change-suite-address' });
  assert.equal(file.read().kind, 'domain');
  assert.equal(file.read().baseDomain, 'mos.example.com');

  fs.writeFileSync(file.addressPath, JSON.stringify({ host: 'home.mos.home', kind: 'guess', scheme: 'http' }));
  assert.throws(() => file.read(), (error) => error.code === 'SUITE_ADDRESS_INVALID');
  fs.writeFileSync(file.addressPath, JSON.stringify({ baseDomain: 'other.example.com', host: 'home.mos.example.com', kind: 'domain', scheme: 'https' }));
  assert.throws(() => file.read(), /disagree/u);
});

test('an offer is its own file beside the address, so writing one never touches the address', () => {
  const file = new SuiteAddressFile({ dir: path.join(tempDir(), 'suite-address') });
  file.write(addressForHost('home.192-168-30-104.local.myownsuite.org'), { by: 'onboarding' });
  const before = fs.readFileSync(file.addressPath, 'utf8');

  assert.equal(file.readOffer(), null);
  file.writeOffer({ acmeEmail: 'owner@example.com', at: '2026-09-20T12:00:00.000Z', baseDomain: 'mos.example.com', from: 'restore' });
  assert.deepEqual(file.readOffer(), { acmeEmail: 'owner@example.com', at: '2026-09-20T12:00:00.000Z', baseDomain: 'mos.example.com', from: 'restore' });
  assert.equal(fs.readFileSync(file.addressPath, 'utf8'), before);

  file.clearOffer();
  assert.equal(file.readOffer(), null);
  file.clearOffer();
  assert.throws(() => file.writeOffer({ baseDomain: 'localhost', from: 'restore' }), SuiteAddressError);
});

// The address is machine-local state: the restore loop only touches targets that
// are backed up and staged, so it cannot reach this directory by construction.
test('the address directory is machine-local in the state table and never staged into a backup', () => {
  const targets = managedStateTargets({ stateDir: '/var/lib/mos/suite-manager', stateRoot: '/var/lib/mos' });
  const address = targets.find((target) => target.id === 'suite-address');
  assert.deepEqual(address, { backedUp: false, class: 'machine-local', id: 'suite-address', kind: 'directory', path: '/var/lib/mos/suite-address' });
  assert.equal(suiteAddressDir('/var/lib/mos'), path.join('/var/lib/mos', 'suite-address'));

  // The Caddyfile belongs to the machine's address too; the two route fragments
  // are projections a restore resets and rebuilds.
  assert.equal(targets.find((target) => target.id === 'caddy-Caddyfile').class, 'machine-local');
  for (const id of ['caddy-mos-app-routes.caddy', 'caddy-mos-homepage-routes.caddy']) {
    const fragment = targets.find((target) => target.id === id);
    assert.equal(fragment.class, 'generated-runtime');
    assert.equal(fragment.backedUp, false);
    assert.match(fragment.emptyContent, /^# No /u);
  }
});
