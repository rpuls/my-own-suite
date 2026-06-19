const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROL_PLANE_COMPONENTS,
  createBootstrapConfig,
  defaultDomainFor,
  renderBootstrapPlan,
  validateBootstrapInput,
} = require('../scripts/installers/bootstrap-contract.cjs');
const { parseArgs, selectOutput } = require('../scripts/installers/render-bootstrap.cjs');

test('bootstrap contract defaults to a no-preconfig control-plane install', () => {
  const plan = renderBootstrapPlan({});

  assert.equal(plan.config.noPreconfig, true);
  assert.equal(plan.config.repoRef, 'feat/app-platform-v2-lab');
  assert.equal(plan.config.domain, 'localhost');
  assert.deepEqual(plan.config.components, CONTROL_PLANE_COMPONENTS);
  assert.match(plan.config.publicUrls.suiteManager, /^http:\/\/localhost\/setup\/$/);
  assert.doesNotMatch(plan.env, /OWNER_EMAIL|OWNER_PASSWORD|MOS_OWNER/);
  assert.doesNotMatch(plan.env, /SELECTED_APPS|MOS_APPS|STIRLING|VAULTWARDEN/);
  assert.match(plan.env, /MOS_V2_OWNER_SETUP='suite-manager-browser'/);
  assert.match(plan.env, /MOS_V2_APP_SELECTION='suite-manager-after-install'/);
});

test('bootstrap contract derives sslip.io domain for cloud smoke installs', () => {
  const config = createBootstrapConfig({
    frontDoor: 'digitalocean-smoke',
    publicIpv4: '203.0.113.42',
    repoRef: 'feature/test-ref',
  });

  assert.equal(defaultDomainFor({ publicIpv4: '203.0.113.42' }), '203.0.113.42.sslip.io');
  assert.equal(config.domain, '203.0.113.42.sslip.io');
  assert.equal(config.publicUrls.suiteManager, 'http://suite-manager.203.0.113.42.sslip.io/setup/');
  assert.equal(config.repoRef, 'feature/test-ref');
});

test('bootstrap contract rejects owner credentials and app config at installer time', () => {
  assert.deepEqual(validateBootstrapInput({
    MOS_OWNER_EMAIL: 'owner@example.com',
    ownerPassword: 'secret',
    selectedApps: ['vaultwarden'],
    MOS_APPS: 'stirling-pdf',
  }), [
    'Owner credential input is not allowed before first boot: ownerPassword.',
    'Owner credential input is not allowed before first boot: MOS_OWNER_EMAIL.',
    'App selection/config input is not allowed during control-plane bootstrap: selectedApps.',
    'App selection/config input is not allowed during control-plane bootstrap: MOS_APPS.',
  ]);

  assert.throws(() => renderBootstrapPlan({ MOS_SMOKE_OWNER_PASSWORD: 'secret' }), /Owner credential input/);
});

test('rendered cloud, SSH, and USB payloads share the same bootstrap contract', () => {
  const plan = renderBootstrapPlan({
    domain: 'mos.example.test',
    repoRef: 'refs/heads/v2-smoke',
    repoUrl: 'https://example.test/mos.git',
  });

  for (const rendered of [plan.cloudInit, plan.sshBootstrap, plan.usbSeed]) {
    assert.match(rendered, /MOS_V2_REPO_URL='https:\/\/example.test\/mos.git'/);
    assert.match(rendered, /MOS_V2_REPO_REF='refs\/heads\/v2-smoke'/);
    assert.match(rendered, /MOS_V2_DOMAIN='mos.example.test'/);
    assert.match(rendered, /suite-manager.mos.example.test\/setup\//);
    assert.doesNotMatch(rendered, /MOS_OWNER_PASSWORD|MOS_SMOKE_OWNER_PASSWORD|MOS_SELECTED_APPS/);
  }
});

test('render CLI parses dry-run target inputs without requiring an env file', () => {
  const parsed = parseArgs([
    '--target',
    'cloud-init',
    '--public-ipv4',
    '198.51.100.17',
    '--repo-ref',
    'test-ref',
  ]);
  const plan = renderBootstrapPlan(parsed.input);

  assert.equal(parsed.target, 'cloud-init');
  assert.equal(plan.config.domain, '198.51.100.17.sslip.io');
  assert.match(selectOutput(plan, parsed.target), /^#cloud-config/);
  assert.match(selectOutput(plan, 'json'), /"suiteManager": "http:\/\/suite-manager.198.51.100.17.sslip.io\/setup\/"/);
});
