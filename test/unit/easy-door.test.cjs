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
  detectEasyDoorBase,
  easyDoorBaseDomain,
  easyDoorHomeHost,
  easyDoorOpen,
  isPrivateIPv4,
} = require('../../shared/easy-door.cjs');
const { renderCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');

function tempFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-easy-door-')), 'Caddyfile');
  fs.writeFileSync(file, contents);
  return file;
}

test('only RFC1918 addresses get an Easy Door name', () => {
  for (const address of ['10.0.0.5', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.123.45']) {
    assert.equal(isPrivateIPv4(address), true, `${address} is RFC1918`);
  }
  // The restriction is the anti-phishing control, not tidiness: a public address
  // under the MOS name would make the zone an open redirector.
  for (const address of ['203.0.113.9', '172.15.0.1', '172.32.0.1', '192.169.1.1', '8.8.8.8', '127.0.0.1']) {
    assert.equal(isPrivateIPv4(address), false, `${address} is not RFC1918`);
    assert.equal(easyDoorBaseDomain(address), null);
    assert.equal(easyDoorHomeHost(address), null);
  }
  for (const address of ['', null, undefined, '192.168.1', '192.168.1.256', '192.168.01.42', 'home.mos.home']) {
    assert.equal(isPrivateIPv4(address), false);
    assert.equal(easyDoorHomeHost(address), null);
  }
});

test('the Easy Door name places the address in its own label under the MOS zone', () => {
  assert.equal(easyDoorBaseDomain('192.168.123.45'), '192-168-123-45.local.myownsuite.org');
  assert.equal(easyDoorHomeHost('192.168.123.45'), 'home.192-168-123-45.local.myownsuite.org');
  assert.equal(easyDoorHomeHost('10.0.0.5'), 'home.10-0-0-5.local.myownsuite.org');
});

test('Caddy matches exactly the home names the nameserver answers', () => {
  const pattern = new RegExp(EASY_DOOR_HOME_HOST_REGEXP, 'u');

  for (const address of ['10.0.0.5', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.123.45']) {
    assert.equal(pattern.test(easyDoorHomeHost(address)), true, `${address} must be matched`);
  }
  for (const host of [
    'home.203-0-113-9.local.myownsuite.org',
    'home.172-32-0-1.local.myownsuite.org',
    'home.172-15-0-1.local.myownsuite.org',
    'home.192-169-1-1.local.myownsuite.org',
    'home.192-168-1-999.local.myownsuite.org',
    'home.192-168-123-45.local.myownsuite.org.evil.example.com',
    'evil.home.192-168-123-45.local.myownsuite.org',
    'seafile.192-168-123-45.local.myownsuite.org',
    'home.mos.home',
  ]) {
    assert.equal(pattern.test(host), false, `${host} must not be matched`);
  }
});

test('the Easy Door is open only while the live Caddyfile serves it', () => {
  const open = tempFile(renderCaddyfile());
  const closed = tempFile('http://home.mos.example.com {\n  reverse_proxy 127.0.0.1:3100\n}\n');

  assert.equal(renderCaddyfile().includes(EASY_DOOR_CADDY_MARKER), true);
  assert.equal(easyDoorOpen(open), true);
  assert.equal(easyDoorOpen(closed), false);
  assert.equal(easyDoorOpen(path.join(path.dirname(closed), 'absent')), false);

  assert.equal(detectEasyDoorBase({ caddyfilePath: open, serverAddress: '192.168.123.45' }), '192-168-123-45.local.myownsuite.org');
  assert.equal(detectEasyDoorBase({ caddyfilePath: open, serverAddress: '203.0.113.9' }), null);
  assert.equal(detectEasyDoorBase({ caddyfilePath: closed, serverAddress: '192.168.123.45' }), null);
});
