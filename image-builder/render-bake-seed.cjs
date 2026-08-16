#!/usr/bin/env node
// Renders the autoinstall seed for the bake VM.
//
// It is the published seed, unmodified, plus a finalize hook. Reusing
// `renderSeed` rather than restating it is the whole point: the image is then
// the machine MOS already ships, pre-made, instead of a second definition of one
// that can drift from it.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const {
  assertSmokeRepoRefContainsRootLayout,
  loadSmokeConfig,
  renderSeed,
} = require('../scripts/installers/render-hyperv-usb-seed.cjs');

const repoRoot = path.resolve(__dirname, '..');
const payloadDir = path.join(__dirname, 'payload');
const outputDir = path.join(__dirname, '.work', 'seed');

// Copied from render-hyperv-usb-seed.cjs, which does not export them. Asserted
// against the rendered seed below, so a drift fails the build instead of
// silently leaving the bake VM's login in the published image.
const consoleIssueBeginMarker = '### My Own Suite server login (begin)';
const consoleIssueEndMarker = '### My Own Suite server login (end)';

// The console banner says a DNS override is needed and points here rather than
// explaining hosts files on a login screen. Step 4 of that page is the override.
const networkDocsUrl = 'https://myownsuite.org/docs/install/own-hardware/';

// The banner stopped explaining DNS on a login screen, so this page carries what
// it no longer says: that the second address is resolved by a My Own Suite
// nameserver, that those lookups are not logged, and that the answer only ever
// points back at the machine. Those are commitments in CHANGELOG.md and
// docs/decisions.md — they moved here, they did not go away.
const easyAddressDocsUrl = 'https://myownsuite.org/docs/install/easy-address/';

const payloadScripts = [
  'mos-image-finalize',
  'mos-self-install',
  'mos-grow-root',
  'mos-first-boot',
];

const payloadUnits = [
  'mos-image-finalize.service',
  'mos-ssh-hostkeys.service',
  'mos-self-install.service',
  'mos-grow-root.service',
  'mos-first-boot.service',
];

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, stdout: String(result.stdout || '').trim() };
}

// The bake VM clones over the network, so a ref that only exists locally
// produces a VM that installs nothing and a bake that fails 40 minutes in.
function assertRefIsPushed(repoRef) {
  const remote = git(['ls-remote', '--exit-code', 'origin', repoRef]);
  if (remote.status !== 0) {
    throw new Error(
      `MOS_IMAGE_REPO_REF=${repoRef} does not exist on origin. The bake VM clones from GitHub, ` +
      'so push the ref first or bake from one that is already there (staging).',
    );
  }
}

// `.gitattributes` pins these to LF, but normalize anyway: renderBootstrapShell
// does the same, and a checkout that slipped through would otherwise bake a
// shebang line ending in \r onto every machine flashed from the build.
function readPayload(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
}

function fill(name, template, values) {
  const filled = Object.entries(values).reduce(
    (text, [key, value]) => text.split(`@@${key}@@`).join(value),
    template,
  );
  // An unfilled placeholder is not a build error anywhere else in the chain — it
  // just bakes '@@DOCS_URL@@' onto the login screen of every machine.
  const leftover = filled.match(/@@[A-Z_]+@@/g);
  if (leftover) {
    throw new Error(`${name} still contains unfilled placeholders: ${[...new Set(leftover)].join(', ')}`);
  }
  return filled;
}

function main() {
  const repoRef = String(process.env.MOS_IMAGE_REPO_REF || 'staging').trim();
  assertRefIsPushed(repoRef);
  assertSmokeRepoRefContainsRootLayout(repoRef);

  // 'lab' bakes a known console password into the VM so a failed finalize can be
  // logged into and read. It must never produce a published image, which is why
  // the summary below records which profile was used.
  const profile = process.env.MOS_IMAGE_BAKE_DEBUG === '1' ? 'lab' : 'release';

  const config = loadSmokeConfig();
  const rendered = renderSeed(config, { profile, repoRef });

  if (!rendered.userData.includes(consoleIssueBeginMarker)) {
    throw new Error(
      `The rendered seed no longer contains '${consoleIssueBeginMarker}'. ` +
      'The finalize step strips the console-login block by that marker; update image-builder to match.',
    );
  }

  const userData = YAML.parse(rendered.userData);
  const firstBoot = userData.autoinstall['user-data'];
  const stateDir = `${rendered.plan.config.stateRoot}/suite-manager`;

  const values = {
    DOCS_URL: networkDocsUrl,
    DOMAIN: rendered.plan.config.domain,
    EASY_DOCS_URL: easyAddressDocsUrl,
    HOME_URL: rendered.plan.config.publicUrls.home,
    ISSUE_BEGIN: consoleIssueBeginMarker,
    ISSUE_END: consoleIssueEndMarker,
    REPO_REF: repoRef,
    STATE_DIR: stateDir,
    USERNAME: rendered.linuxUsername,
  };

  const writeFiles = [];
  for (const name of payloadScripts) {
    writeFiles.push({
      content: fill(name, readPayload(payloadDir, name), values),
      path: `/usr/local/sbin/${name}`,
      permissions: '0755',
    });
  }
  for (const name of payloadUnits) {
    writeFiles.push({
      content: readPayload(path.join(payloadDir, 'units'), name),
      path: `/etc/systemd/system/${name}`,
      permissions: '0644',
    });
  }

  firstBoot.write_files = [...(firstBoot.write_files || []), ...writeFiles];
  // Last, so the control plane is fully installed and running before the machine
  // is turned into an image of one.
  firstBoot.runcmd = [
    ...(firstBoot.runcmd || []),
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', 'mos-image-finalize.service'],
  ];
  // Finalize runs on the next boot rather than here: cloud-init state can only
  // be cleaned up safely once cloud-init is no longer running.
  firstBoot.power_state = {
    condition: true,
    delay: 'now',
    message: 'Rebooting to finalize the My Own Suite image',
    mode: 'reboot',
    timeout: 120,
  };

  fs.rmSync(outputDir, { force: true, recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'user-data'),
    `#cloud-config\n${YAML.stringify(userData, { lineWidth: 0 })}`,
    'utf8',
  );
  fs.writeFileSync(path.join(outputDir, 'meta-data'), rendered.metaData, 'utf8');

  const summary = {
    consoleLoginHandover: rendered.consoleLoginHandover,
    domain: rendered.plan.config.domain,
    home: rendered.plan.config.publicUrls.home,
    profile,
    repoRef,
    setup: rendered.plan.config.publicUrls.setup,
  };
  fs.writeFileSync(
    path.join(outputDir, 'bake-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );

  console.log(`[mos-image] Bake seed rendered for ${repoRef} (${profile} profile).`);
  console.log(`[mos-image] Stealth-door URL baked into the banner: ${summary.home}`);
  console.log(`[mos-image] Seed: ${outputDir}`);
  if (profile === 'lab') {
    console.log('[mos-image] WARNING: debug bake. This image carries a fixed password and must not be published.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-image] ${error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = { main };
