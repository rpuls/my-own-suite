// Roadmap H2. The prebuilt-image work in `image-builder/` bakes the control plane
// by running `renderBootstrapShell` output inside a VM. That is only safe while
// the same function keeps rendering the cloud paths byte-for-byte, because the
// published cloud walkthrough documents their exact on-screen output.
//
// A failure here is not a bug in this test. It means the cloud installer changed,
// and the recording that documents it is now wrong. Update the digest only
// together with a deliberate decision to re-record.
//
// Moved 2026-09-01 for the journald persistence block (roadmap I5). The script
// bytes changed in all five renderings; not one `echo` line did, so nothing the
// walkthrough shows on screen moved and no re-recording was needed. That is the
// bar for updating these without re-recording: compare the echo lines, not the
// digests, and if any of them differ the recording is genuinely stale.
//
// Moved again 2026-09-06 to install the backup storage engine, which only the
// managed-update path had. One echo line was added and it writes to stderr on a
// failed download, which a successful walkthrough never reaches; the engine
// installer's own progress is sent to /dev/null for that reason.

// Moved 2026-09-07 for the control-plane status page (roadmap A6): every Suite
// Manager site block gained a `handle_errors` handler so a restore answers with
// a page instead of a bare 502. All five digests moved this time rather than
// only the last, because the handler went into `renderPublicCloudCaddyfile()`
// as well as `renderCaddyfile()`. No `echo` line changed in any rendering — the
// bar stated above — so the walkthrough recording is still accurate.
//
// Moved the same day, all five again: the installer now writes that status page
// itself, since a fresh install never runs the reconciler that was its only
// writer. No `echo` line changed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { renderBootstrapPlan } = require('../../scripts/installers/bootstrap-contract.cjs');

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const lockedRenderings = [
  {
    digest: 'ef297d0add871f7670023ddc60d634138360b22ca5201e935c61e440c1f638f3',
    input: { frontDoor: 'public-vps', publicIpv4: '203.0.113.10' },
    name: 'the public VPS one-line installer',
    output: 'sshBootstrap',
  },
  {
    digest: '074e127f90499928b2825e0ccb1b2285e9ac6e12de77de94440de309ad7fc27c',
    input: { frontDoor: 'public-vps', publicIpv4: '203.0.113.10' },
    name: 'the public VPS cloud-init payload',
    output: 'cloudInit',
  },
  {
    digest: '1fb64e6dd072e824a3b342e7ae875574be21391bab339fb2131427112c0c3e4a',
    input: { frontDoor: 'cloud-init', publicIpv4: '203.0.113.10' },
    name: 'the cloud-init front door',
    output: 'cloudInit',
  },
  {
    digest: '78a7c3312c58bba9ad8b090d37a78ce75838c662715054b7f759a23913fa5749',
    input: { frontDoor: 'digitalocean-smoke' },
    name: 'the DigitalOcean smoke front door',
    output: 'cloudInit',
  },
  {
    // The only locked rendering that writes `renderCaddyfile()` rather than
    // `renderPublicCloudCaddyfile()`, so a change to the local Caddyfile lands
    // here and nowhere else in this list. Moved once, for the Easy Door site
    // block; nothing the installer prints changed.
    digest: '8d6fdda121dc128483e8c2f423bcc3c8b06cfb930c3c5e404ea1a910582700e8',
    input: {},
    name: 'the default SSH bootstrap',
    output: 'sshBootstrap',
  },
];

for (const locked of lockedRenderings) {
  test(`${locked.name} renders byte-identically`, () => {
    const rendered = renderBootstrapPlan(locked.input)[locked.output];
    assert.equal(
      digest(rendered),
      locked.digest,
      `${locked.name} (${locked.output}) changed. The recorded cloud walkthrough documents this exact ` +
      'output, so re-record it or revert the change before updating this digest.',
    );
  });
}

test('the USB front door still shares one definition with the cloud paths', () => {
  const usb = renderBootstrapPlan({ domain: 'mos.home', frontDoor: 'usb-autoinstall' });
  const cloud = renderBootstrapPlan({ frontDoor: 'public-vps', publicIpv4: '203.0.113.10' });

  // Same components, same install root, same owner-setup contract: the prebuilt
  // image must stay a second packaging of one machine, never a second machine.
  assert.deepEqual(usb.config.components, cloud.config.components);
  assert.equal(usb.config.installRoot, cloud.config.installRoot);
  assert.equal(usb.config.stateRoot, cloud.config.stateRoot);
  assert.equal(usb.config.noPreconfig, cloud.config.noPreconfig);
  assert.match(usb.env, /MOS_OWNER_SETUP='suite-manager-browser'/);
  assert.match(usb.env, /MOS_DISPOSABLE_LAB='0'/);
});
