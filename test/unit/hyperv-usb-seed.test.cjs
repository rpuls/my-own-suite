const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');

const {
  generateLinuxPassword,
  loadSmokeConfig,
  renderSeed,
  resolveSmokeRepoRef,
} = require('../../scripts/installers/render-hyperv-usb-seed.cjs');

test('Hyper-V USB seed embeds the MOS bootstrap without the v1 owner handoff', () => {
  const rendered = renderSeed(
    {
      HOSTNAME: 'mos',
      LINUX_PASSWORD: 'linux-console-password',
      OWNER_EMAIL: 'v1-owner@example.com',
      OWNER_PASSWORD: 'v1-owner-password',
      STACK_DOMAIN: 'mos.home',
    },
    { repoRef: 'staging' },
  );
  const document = YAML.parse(rendered.userData);
  const firstBoot = document.autoinstall['user-data'];
  const renderedFirstBoot = YAML.stringify(firstBoot);

  assert.equal(document.autoinstall.identity.hostname, 'mos');
  assert.equal(rendered.plan.config.frontDoor, 'usb-autoinstall');
  assert.equal(rendered.plan.config.repoRef, 'staging');
  assert.equal(rendered.plan.config.publicUrls.home, 'http://home.mos.home/');
  assert.match(renderedFirstBoot, /MOS_REPO_REF='staging'/u);
  assert.match(renderedFirstBoot, /mos-suite-manager\.service/u);
  assert.match(renderedFirstBoot, /linux-console-password/u);
  assert.equal(rendered.linuxPassword, 'linux-console-password');
  assert.equal(rendered.linuxPasswordGenerated, false);
  assert.match(renderedFirstBoot, /mkfs\.ext4 -F -L MOS_BACKUP/u);
  assert.match(renderedFirstBoot, /\/media\/mos-backup/u);
  assert.match(renderedFirstBoot, /No empty second disk found for backup storage/u);
  assert.doesNotMatch(rendered.userData, /v1-owner@example\.com|v1-owner-password|mos-selfhost-bootstrap/u);
});

test('Hyper-V USB seed generates a random Linux password when none is configured', () => {
  for (const config of [{}, { LINUX_PASSWORD: 'change-me-before-build' }, { LINUX_PASSWORD: '   ' }]) {
    const rendered = renderSeed(config, { repoRef: 'staging' });
    assert.equal(rendered.linuxPasswordGenerated, true);
    assert.match(rendered.linuxPassword, /^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/u);
    assert.equal(rendered.linuxUsername, 'mos');
    assert.ok(rendered.userData.includes(rendered.linuxPassword));
    assert.doesNotMatch(rendered.userData, /change-me-before-build/u);
  }
});

test('generated Linux passwords are console-typable and unique', () => {
  const one = generateLinuxPassword();
  const two = generateLinuxPassword();
  assert.match(one, /^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/u);
  assert.doesNotMatch(one, /[01lo]/u);
  assert.notEqual(one, two);
});

test('Hyper-V USB seed works without a local installer env and without template values', () => {
  // loadSmokeConfig may pick up a developer's local gitignored env file, so only
  // assert that it renders; the no-config default path is covered via renderSeed({}).
  const rendered = renderSeed(loadSmokeConfig(), { repoRef: 'staging' });
  assert.ok(rendered.plan.config.publicUrls.home.startsWith('http://home.'));

  const defaults = renderSeed({}, { repoRef: 'staging' });
  assert.equal(defaults.plan.config.publicUrls.home, 'http://home.mos.home/');
  assert.equal(defaults.linuxPasswordGenerated, true);
});

test('Hyper-V USB seed repo ref is explicit for branch smoke installs', () => {
  assert.equal(resolveSmokeRepoRef({ MOS_SMOKE_REPO_REF: 'feat/root-layout-smoke' }), 'feat/root-layout-smoke');
});
