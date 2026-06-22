const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');

const { renderSeed } = require('../scripts/installers/render-hyperv-usb-seed.cjs');

test('Hyper-V USB seed embeds the V2 bootstrap without the v1 owner handoff', () => {
  const rendered = renderSeed({
    HOSTNAME: 'mos',
    LINUX_PASSWORD: 'linux-console-password',
    OWNER_EMAIL: 'v1-owner@example.com',
    OWNER_PASSWORD: 'v1-owner-password',
    STACK_DOMAIN: 'mos.home',
  });
  const document = YAML.parse(rendered.userData);
  const firstBoot = document.autoinstall['user-data'];
  const renderedFirstBoot = YAML.stringify(firstBoot);

  assert.equal(document.autoinstall.identity.hostname, 'mos');
  assert.equal(rendered.plan.config.frontDoor, 'usb-autoinstall');
  assert.equal(rendered.plan.config.repoRef, 'feat/app-platform-v2-lab');
  assert.equal(rendered.plan.config.publicUrls.home, 'http://home.mos.home/');
  assert.match(renderedFirstBoot, /MOS_V2_REPO_REF='feat\/app-platform-v2-lab'/u);
  assert.match(renderedFirstBoot, /mos-v2-suite-manager\.service/u);
  assert.match(renderedFirstBoot, /linux-console-password/u);
  assert.doesNotMatch(rendered.userData, /v1-owner@example\.com|v1-owner-password|mos-selfhost-bootstrap/u);
});
