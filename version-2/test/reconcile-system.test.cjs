const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  homepageUnit,
  resolveRuntimeConfig,
  suiteManagerUnit,
} = require('../scripts/reconcile-system.cjs');

test('system reconciliation preserves the installed Home host from the bootstrap contract', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-reconcile-'));
  context.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));

  fs.writeFileSync(path.join(tempDir, 'bootstrap-contract.env'), [
    "MOS_V2_FRONT_DOOR='usb-autoinstall'",
    "MOS_V2_DOMAIN='mos.home'",
    "MOS_V2_RUNTIME_USER='mos'",
    "MOS_V2_SUITE_MANAGER_PORT='3100'",
    "MOS_V2_HOMEPAGE_PORT='3200'",
    'MOS_V2_HOME_URL="http://home.mos.home/"',
    '',
  ].join('\n'));

  const config = resolveRuntimeConfig({
    MOS_V2_REPO_DIR: '/opt/mos-v2/repo',
    MOS_V2_STATE_ROOT: tempDir,
  });
  const unit = suiteManagerUnit(config);
  const homepage = homepageUnit(config);

  assert.equal(config.homeHost, 'home.mos.home');
  assert.equal(config.frontDoor, 'usb-autoinstall');
  assert.match(unit, /Environment=MOS_V2_HOME_HOST=home\.mos\.home/u);
  assert.match(unit, /Environment=MOS_V2_FRONT_DOOR=usb-autoinstall/u);
  assert.doesNotMatch(unit, /home\.localhost/u);
  assert.match(homepage, /HOMEPAGE_ALLOWED_HOSTS=home\.mos\.home/u);
  assert.match(homepage, new RegExp(`${tempDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\/homepage\\/config:\\/app\\/config`, 'u'));
  assert.doesNotMatch(homepage, /\$MOS_V2_(HOME_HOST|STATE_ROOT|HOMEPAGE_PORT)/u);
});
