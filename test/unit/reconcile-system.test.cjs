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
const { JOURNALD_CONFIG_PATH, renderJournaldConfig } = require('../../infrastructure/control-plane-runtime.cjs');
const { renderBootstrapPlan } = require('../../scripts/installers/bootstrap-contract.cjs');

test('system reconciliation preserves the installed Home host from the bootstrap contract', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-reconcile-'));
  context.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));

  fs.writeFileSync(path.join(tempDir, 'bootstrap-contract.env'), [
    "MOS_FRONT_DOOR='usb-autoinstall'",
    "MOS_DOMAIN='mos.home'",
    "MOS_RUNTIME_USER='mos'",
    "MOS_SUITE_MANAGER_PORT='3100'",
    "MOS_HOMEPAGE_PORT='3200'",
    'MOS_HOME_URL="http://home.mos.home/"',
    '',
  ].join('\n'));

  const config = resolveRuntimeConfig({
    MOS_REPO_DIR: '/opt/mos/repo',
    MOS_STATE_ROOT: tempDir,
  });
  const unit = suiteManagerUnit(config);
  const homepage = homepageUnit(config);

  assert.equal(config.homeHost, 'home.mos.home');
  assert.equal(config.frontDoor, 'usb-autoinstall');
  // This contract predates the flag, which is exactly the shape that used to be
  // inferred from the front door and put a wipe endpoint on published images.
  assert.equal(config.disposableLab, '0');
  assert.match(unit, /Environment=MOS_HOME_HOST=home\.mos\.home/u);
  assert.match(unit, /Environment=MOS_FRONT_DOOR=usb-autoinstall/u);
  assert.match(unit, /Environment=MOS_DISPOSABLE_LAB=0/u);
  assert.match(unit, /Environment=MOS_LAB_RESET_AGENT_SOCKET=\/run\/mos-lab-reset-agent\/agent\.sock/u);
  assert.match(unit, new RegExp(`Environment=MOS_APP_PACKAGE_ROOT=${tempDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\/app-packages`, 'u'));
  assert.doesNotMatch(unit, /home\.localhost/u);
  assert.match(homepage, /HOMEPAGE_ALLOWED_HOSTS=home\.mos\.home/u);
  assert.match(homepage, new RegExp(`${tempDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\/homepage\\/config:\\/app\\/config`, 'u'));
  assert.doesNotMatch(homepage, /\$MOS_(HOME_HOST|STATE_ROOT|HOMEPAGE_PORT)/u);
});

// Reconciliation must provision the package root exactly as the installer's
// bootstrap does, or a managed update leaves a root the installer would have
// made readable. The reconcile path itself only runs as root, so pin the
// contract at the source, as the other script contracts here are pinned.
test('system reconciliation provisions the app package root readable by Suite Manager', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'reconcile-system.cjs'), 'utf8');

  // Setgid: snapshots the root agent writes below must inherit mos-agent,
  // because Suite Manager reads them to re-verify installed package identity.
  assert.match(script, /installDir\(`\$\{stateRoot\}\/app-packages`, 0o2750\)/u);
  assert.match(script, /run\('chown', \['root:mos-agent', `\$\{stateRoot\}\/app-packages`\]\)/u);
  // Applied after the chown, which can clear the setgid bit.
  assert.match(script, /chmodSync\(`\$\{stateRoot\}\/app-packages`, 0o2750\)/u);
});

// AGENTS.md rule 7: a managed update must not leave a machine running old
// platform-owned state after reporting success. Host settings have two owners —
// the installer, which a machine that already exists never runs again, and this
// reconciler, which every managed update runs — so a setting written by only one
// of them silently reaches only reflashed machines or only updated ones. This
// asserts both paths emit the identical journald configuration from the one
// shared definition, which is the property that made the split safe.
test('the installer and a managed update write the identical journald configuration', () => {
  const rendered = renderJournaldConfig();
  const installer = renderBootstrapPlan({}).sshBootstrap;

  assert.match(rendered, /^\[Journal\]$/mu);
  // Stated rather than left to `Storage=auto`, which is persistent only for as
  // long as /var/log/journal happens to exist.
  assert.match(rendered, /^Storage=persistent$/mu);
  // The half that was actually missing: upstream leaves SystemMaxUse unset, so
  // the journal may grow to a tenth of the disk the apps are also using.
  assert.match(rendered, /^SystemMaxUse=\d+M$/mu);

  assert.ok(
    installer.includes(`cat > ${JOURNALD_CONFIG_PATH} <<'MOS_JOURNALD'\n${rendered}MOS_JOURNALD`),
    'the installer must write the shared journald definition verbatim',
  );

  const reconciler = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'reconcile-system.cjs'), 'utf8');
  assert.ok(
    reconciler.includes('writeFile(JOURNALD_CONFIG_PATH, renderJournaldConfig()'),
    'the managed-update path must write the same shared definition, not a copy of it',
  );
});
