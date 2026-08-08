const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');

const {
  consoleLoginAcknowledgedFileName,
  consoleLoginFileName,
  labLinuxPassword,
  loadSmokeConfig,
  renderSeed,
  resolveSeedProfile,
  resolveSmokeRepoRef,
} = require('../../scripts/installers/render-hyperv-usb-seed.cjs');

function writeFilesOf(rendered) {
  return YAML.parse(rendered.userData).autoinstall['user-data'].write_files || [];
}

function fileAt(rendered, targetPath) {
  return writeFilesOf(rendered).find((entry) => entry.path === targetPath);
}

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
  assert.equal(rendered.consoleLoginHandover, 'preconfigured');
  assert.match(renderedFirstBoot, /mkfs\.ext4 -F -L MOS_BACKUP/u);
  assert.match(renderedFirstBoot, /\/media\/mos-backup/u);
  assert.match(renderedFirstBoot, /No empty second disk found for backup storage/u);
  // The Ubuntu install phase must stay offline-capable: no extra packages may
  // be fetched from the archive mid-install.
  assert.equal(document.autoinstall.packages, undefined);
  assert.doesNotMatch(rendered.userData, /qemu-guest-agent/u);
  assert.doesNotMatch(rendered.userData, /v1-owner@example\.com|v1-owner-password|mos-selfhost-bootstrap/u);
});

// The property that makes a published ISO safe: two builds of the same seed
// must be byte-identical, because whatever differs between them would be a
// secret baked into the image every downloader flashes.
test('an unconfigured seed bakes no console password and is reproducible', () => {
  for (const config of [{}, { LINUX_PASSWORD: 'change-me-before-build' }, { LINUX_PASSWORD: '   ' }]) {
    const rendered = renderSeed(config, { profile: 'release', repoRef: 'staging' });
    assert.equal(rendered.consoleLoginHandover, 'first-boot');
    assert.equal(rendered.linuxPassword, '');
    assert.equal(rendered.linuxUsername, 'mos');
    assert.doesNotMatch(rendered.userData, /change-me-before-build/u);

    const rebuilt = renderSeed(config, { profile: 'release', repoRef: 'staging' });
    assert.equal(rebuilt.userData, rendered.userData);
  }
});

test('an unconfigured seed ships a locked account the installer cannot open', () => {
  const identity = YAML.parse(renderSeed({}, { profile: 'release', repoRef: 'staging' }).userData).autoinstall.identity;
  // Not a hash: any hash committed here would be the same hash on every machine
  // that ever flashes this image.
  assert.equal(identity.password, '!');
  assert.doesNotMatch(identity.password, /^\$[0-9a-z]+\$/u);
});

test('first boot generates the console password on the installed machine', () => {
  const rendered = renderSeed({}, { profile: 'release', repoRef: 'staging' });
  const init = fileAt(rendered, '/usr/local/sbin/mos-console-login-init');
  const firstBoot = YAML.parse(rendered.userData).autoinstall['user-data'];

  assert.ok(init, 'the first-boot init script must be written to the target machine');
  assert.equal(init.permissions, '0755');
  assert.match(init.content, /\/dev\/urandom/u);
  assert.match(init.content, /chpasswd/u);
  assert.match(init.content, /state_dir='\/var\/lib\/mos\/suite-manager'/u);
  assert.match(init.content, new RegExp(`handover="\\$state_dir/${consoleLoginFileName}"`, 'u'));
  // Idempotent, so a re-run cannot rotate a password the owner already saved.
  assert.match(init.content, new RegExp(consoleLoginAcknowledgedFileName, 'u'));
  // Ahead of the control-plane bootstrap: a machine whose install failed must
  // still be reachable, or a failed boot is an unrecoverable brick.
  const commands = firstBoot.runcmd.map((entry) => (Array.isArray(entry) ? entry.join(' ') : String(entry)));
  assert.ok(
    commands.findIndex((entry) => entry.includes('mos-console-login-init'))
      < commands.findIndex((entry) => entry.includes('mos-bootstrap-control-plane')),
  );
});

test('the console banner clears itself once the owner confirms', () => {
  const rendered = renderSeed({}, { profile: 'release', repoRef: 'staging' });
  const clear = fileAt(rendered, '/usr/local/sbin/mos-console-login-clear');
  const pathUnit = fileAt(rendered, '/etc/systemd/system/mos-console-login-clear.path');

  assert.ok(clear && pathUnit);
  assert.match(clear.content, /\/etc\/issue/u);
  assert.match(clear.content, new RegExp(`rm -f .*${consoleLoginFileName}`, 'u'));
  // Suite Manager runs unprivileged and cannot edit /etc/issue, so the sentinel
  // it can write is what triggers the root-side cleanup.
  assert.match(pathUnit.content, new RegExp(`PathExists=/var/lib/mos/suite-manager/${consoleLoginAcknowledgedFileName}`, 'u'));
  assert.match(pathUnit.content, /Unit=mos-console-login-clear\.service/u);
});

test('the lab profile gives the Hyper-V VM a fixed login nobody has to look up', () => {
  const rendered = renderSeed({}, { profile: 'lab', repoRef: 'staging' });
  assert.equal(rendered.consoleLoginHandover, 'preconfigured');
  assert.equal(rendered.linuxPassword, labLinuxPassword);
  assert.match(fileAt(rendered, '/usr/local/sbin/mos-console-login-init').content, new RegExp(`password='${labLinuxPassword}'`, 'u'));
});

test('a fixed password still travels the real handover path', () => {
  const rendered = renderSeed({ LINUX_PASSWORD: 'local-smoke-password' }, { repoRef: 'staging' });
  const init = fileAt(rendered, '/usr/local/sbin/mos-console-login-init');

  assert.equal(rendered.linuxPassword, 'local-smoke-password');
  // The whole point of not branching: the lab and smoke VMs exercise the banner,
  // the Suite Manager panel and the cleanup that every published install runs.
  assert.ok(init);
  assert.ok(fileAt(rendered, '/etc/systemd/system/mos-console-login-clear.path'));
  assert.match(init.content, /password='local-smoke-password'/u);
  assert.doesNotMatch(init.content, /dev\/urandom/u);
});

test('a shareable image never carries the lab reset endpoint', () => {
  for (const options of [{ profile: 'release' }, {}, { profile: 'release', config: { LINUX_PASSWORD: 'someones-own-password' } }]) {
    const rendered = renderSeed(options.config || {}, { profile: options.profile, repoRef: 'staging' });
    assert.match(rendered.userData, /MOS_DISPOSABLE_LAB='0'/u);
    assert.doesNotMatch(rendered.userData, /MOS_DISPOSABLE_LAB='1'/u);
  }
});

test('the lab profile keeps the reset endpoint the e2e suite depends on', () => {
  assert.match(renderSeed({}, { profile: 'lab', repoRef: 'staging' }).userData, /MOS_DISPOSABLE_LAB='1'/u);
});

test('only an explicit profile can bake a password into an image', () => {
  assert.equal(resolveSeedProfile({}), 'release');
  assert.equal(resolveSeedProfile({ MOS_SEED_PROFILE: '' }), 'release');
  assert.equal(resolveSeedProfile({ MOS_SEED_PROFILE: 'LAB' }), 'lab');
  assert.throws(() => resolveSeedProfile({ MOS_SEED_PROFILE: 'production' }), /Unknown MOS_SEED_PROFILE/u);
  // The command that builds a shareable ISO must never inherit the lab default.
  assert.equal(renderSeed({}, { profile: 'release', repoRef: 'staging' }).linuxPassword, '');
});

test('Hyper-V USB seed works without a local installer env and without template values', () => {
  // loadSmokeConfig may pick up a developer's local gitignored env file, so only
  // assert that it renders; the no-config default path is covered via renderSeed({}).
  const rendered = renderSeed(loadSmokeConfig(), { repoRef: 'staging' });
  assert.ok(rendered.plan.config.publicUrls.home.startsWith('http://home.'));

  const defaults = renderSeed({}, { profile: 'release', repoRef: 'staging' });
  assert.equal(defaults.plan.config.publicUrls.home, 'http://home.mos.home/');
  assert.equal(defaults.consoleLoginHandover, 'first-boot');
});

test('Hyper-V USB seed repo ref is explicit for branch smoke installs', () => {
  assert.equal(resolveSmokeRepoRef({ MOS_SMOKE_REPO_REF: 'feat/root-layout-smoke' }), 'feat/root-layout-smoke');
});

test('ambient shell HOSTNAME cannot leak the build machine name into the seed', () => {
  const saved = { HOSTNAME: process.env.HOSTNAME, MOS_HOSTNAME: process.env.MOS_HOSTNAME };
  process.env.HOSTNAME = 'BUILD-PC-NAME';
  delete process.env.MOS_HOSTNAME;
  try {
    const rendered = renderSeed(loadSmokeConfig(), { repoRef: 'staging' });
    const hostname = YAML.parse(rendered.userData).autoinstall.identity.hostname;
    assert.notEqual(hostname, 'BUILD-PC-NAME');

    process.env.MOS_HOSTNAME = 'pinned-host';
    const pinned = renderSeed(loadSmokeConfig(), { repoRef: 'staging' });
    assert.equal(YAML.parse(pinned.userData).autoinstall.identity.hostname, 'pinned-host');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
