const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  homepageUnit,
  resolveRuntimeConfig,
  suiteManagerUnit,
} = require('../../scripts/reconcile-system.cjs');

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
  assert.equal(config.labResetEnabled, '1');
  assert.match(unit, /Environment=MOS_V2_HOME_HOST=home\.mos\.home/u);
  assert.match(unit, /Environment=MOS_V2_FRONT_DOOR=usb-autoinstall/u);
  assert.match(unit, /Environment=MOS_V2_LAB_RESET_ENABLED=1/u);
  assert.match(unit, /Environment=MOS_V2_LAB_RESET_AGENT_SOCKET=\/run\/mos-v2-lab-reset-agent\/agent\.sock/u);
  assert.match(unit, new RegExp(`Environment=MOS_V2_APP_PACKAGE_ROOT=${tempDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\/app-packages`, 'u'));
  assert.doesNotMatch(unit, /home\.localhost/u);
  assert.match(homepage, /HOMEPAGE_ALLOWED_HOSTS=home\.mos\.home/u);
  assert.match(homepage, new RegExp(`${tempDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\/homepage\\/config:\\/app\\/config`, 'u'));
  assert.doesNotMatch(homepage, /\$MOS_V2_(HOME_HOST|STATE_ROOT|HOMEPAGE_PORT)/u);
});

// Reconciliation must provision the package root exactly as the installer's
// bootstrap does, or a managed update leaves a root the installer would have
// made readable. The reconcile path itself only runs as root, so pin the
// contract at the source, as the other script contracts here are pinned.
test('system reconciliation provisions the app package root readable by Suite Manager', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'reconcile-system.cjs'), 'utf8');

  // Setgid: snapshots the root agent writes below must inherit mos-v2-agent,
  // because Suite Manager reads them to re-verify installed package identity.
  assert.match(script, /installDir\(`\$\{stateRoot\}\/app-packages`, 0o2750\)/u);
  assert.match(script, /run\('chown', \['root:mos-v2-agent', `\$\{stateRoot\}\/app-packages`\]\)/u);
  // Applied after the chown, which can clear the setgid bit.
  assert.match(script, /chmodSync\(`\$\{stateRoot\}\/app-packages`, 0o2750\)/u);
});
