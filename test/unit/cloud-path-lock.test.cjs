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
//
// Moved 2026-09-09, all five again: the backup and update agent units each gained
// the other's socket path, because a MOS update now backs the suite up first and a
// scheduled backup waits while an update runs. Two `Environment=` lines; no `echo`
// line changed, so the walkthrough recording still shows what an install prints.
//
// Moved 2026-09-16 for host OS patching (roadmap AL1): the installer now applies
// Ubuntu's unattended security-upgrade policy, and the diagnostics agent unit
// carries the state root so it can read the patch state. One command line and
// one `Environment=` line; no `echo` line changed, so the walkthrough recording
// still shows what an install prints.
//
// Moved 2026-09-17 for restore progress (roadmap C8): every Suite Manager site
// block gained the route that serves the backup agent's progress file, and the
// status page gained the inline script that polls it. All five again, for the
// same reason as 2026-09-07. The thirteen `echo` lines of every rendering were
// compared before and after and not one changed, so the walkthrough recording
// still shows what an install prints.

// Moved 2026-09-17 for the encrypted vault (roadmap AL2): the installer installs
// cryptsetup, writes the two vault units and the Docker drop-ins, and every unit
// that holds owner data gained `Requires=mos-vault.service`. All five again. The
// thirteen `echo` lines of every rendering were compared before and after and not
// one changed, so the walkthrough recording still shows what an install prints.
//
// Moved again 2026-09-18, on evidence from the first hardware install: the TPM
// apt line now names the three tss2 libraries systemd loads on demand (Ubuntu
// ships them as Suggests; the lab machine had two of three, and enrollment failed
// with "TPM2 support is not installed") plus tpm2-tools, with a warning `echo`
// that prints only when that run fails. A normal install prints exactly what it did.
//
// Moved once more the same day: the Homepage and lab-reset units gained
// `Requires=mos-vault.service`, so every unit the installer writes now carries
// the same requirement (test/unit/vault-gating.test.cjs holds that rule). No
// `echo` line changed.
//
// Moved 2026-09-20 for the recorded suite address (roadmap A11): the installer
// creates the `suite-address` directory Suite Manager records the address in.
// One argument on one `install -d` line, in all five renderings; the thirteen
// `echo` lines were compared before and after and not one changed.
//
// Moved 2026-09-22 for grouped restore progress: the status page lists the
// job's groups rather than its stages, opens the one that is running, and
// styles the parts inside it. Page markup, CSS and script only, in all five
// renderings; the thirteen `echo` lines were compared before and after and not
// one changed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { renderBootstrapPlan } = require('../../scripts/installers/bootstrap-contract.cjs');

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const lockedRenderings = [
  {
    digest: '3be27eddcadaaf997c05ce6a739af7de60aa9eaff0e8209e8bb506dd99b98fb4',
    input: { frontDoor: 'public-vps', publicIpv4: '203.0.113.10' },
    name: 'the public VPS one-line installer',
    output: 'sshBootstrap',
  },
  {
    digest: '7cf15c851bc078b2865636d9892c9bdfb1d925a814f54dce6ec1aaaa1cf3d05b',
    input: { frontDoor: 'public-vps', publicIpv4: '203.0.113.10' },
    name: 'the public VPS cloud-init payload',
    output: 'cloudInit',
  },
  {
    digest: '675857e712a4fa66745da9e27d5925ce14e49f79ac8a38502a75f62bfd909274',
    input: { frontDoor: 'cloud-init', publicIpv4: '203.0.113.10' },
    name: 'the cloud-init front door',
    output: 'cloudInit',
  },
  {
    digest: '0d9ca6ab01b627e544f2b4dd14bca220bd03a766d029968b6a97d960c1b96acf',
    input: { frontDoor: 'digitalocean-smoke' },
    name: 'the DigitalOcean smoke front door',
    output: 'cloudInit',
  },
  {
    // The only locked rendering that writes `renderCaddyfile()` rather than
    // `renderPublicCloudCaddyfile()`, so a change to the local Caddyfile lands
    // here and nowhere else in this list. Moved once, for the Easy Door site
    // block; nothing the installer prints changed.
    digest: 'f54da13ce668427782ef8eb1cdbc373a64dae9f8f5a9094c0fc9ff115d4543e1',
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
