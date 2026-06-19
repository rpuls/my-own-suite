const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HOMEPAGE_IMAGE,
  renderCaddyfile,
  renderHomepageSystemdUnit,
} = require('../infrastructure/control-plane-runtime.cjs');

test('Caddy exposes Home and Suite Manager only through Suite Manager', () => {
  const caddyfile = renderCaddyfile();

  assert.match(caddyfile, /http:\/\/\$MOS_V2_HOME_HOST/);
  assert.match(caddyfile, /http:\/\/\$MOS_V2_SUITE_MANAGER_HOST/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:\$MOS_V2_SUITE_MANAGER_PORT/);
  assert.doesNotMatch(caddyfile, /3200|homepage:3000|reverse_proxy\s+homepage/);
});

test('Homepage runtime is pinned and reachable only through loopback', () => {
  const unit = renderHomepageSystemdUnit();

  assert.match(HOMEPAGE_IMAGE, /^ghcr\.io\/gethomepage\/homepage@sha256:[a-f0-9]{64}$/);
  assert.match(unit, /--publish 127\.0\.0\.1:3200:3000/);
  assert.match(unit, /HOMEPAGE_ALLOWED_HOSTS=\$MOS_V2_HOME_HOST/);
  assert.match(unit, /\/homepage\/config:\/app\/config/);
  assert.doesNotMatch(unit, /0\.0\.0\.0:3200|--network host/);
});
