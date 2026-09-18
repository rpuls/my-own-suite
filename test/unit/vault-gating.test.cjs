// One rule over every unit MOS renders, from every place units come from:
// a unit either requires the vault gate or is named below with the reason it
// touches nothing the vault protects. The first hardware install found three
// units that did neither — the login generator, the post-patch check and, one
// platform update later, every reconciled agent — and each wrote to the
// plaintext side of a protected path while the vault was locked. A new unit
// that forgets the requirement fails here rather than on someone's disk.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { renderPostPatchUnit } = require('../../infrastructure/host-patching.cjs');
const { renderBootstrapPlan } = require('../../scripts/installers/bootstrap-contract.cjs');
const { renderSeed } = require('../../scripts/installers/render-hyperv-usb-seed.cjs');
const { renderUnits } = require('../../scripts/reconcile-system.cjs');

// The protected paths, as `system-agents/vault/agent-core.cjs` lists them. A
// unit that reads or writes under any of these waits for the gate.
const VAULT_INDEPENDENT = {
  'mos-first-boot.service': 'paints the address banner from /run and the network; reads nothing under a protected path',
  'mos-image-finalize.service': 'runs once at bake time, before the image is armed and before a vault can exist',
  'mos-self-install.service': 'copies the installer stick to the disk; a vault does not exist yet',
  'mos-ssh-hostkeys.service': 'makes host keys under /etc/ssh, on the plaintext partition by design',
  'mos-vault-agent.service': 'speaks for a locked machine: it serves the page the key is typed into',
  'mos-vault.service': 'is the gate',
};

const GATED = /^Requires=.*\bmos-vault\.service\b/mu;

function bootstrapUnits() {
  const shell = renderBootstrapPlan({}).sshBootstrap;
  const units = {};
  const dropIns = {};
  for (const match of shell.matchAll(/cat > (\/etc\/systemd\/system\/\S+) <<'?([A-Z_]+)'?\n([\s\S]*?)\n\2\n/gu)) {
    const name = path.posix.basename(match[1]);
    if (match[1].includes('.d/')) dropIns[match[1]] = match[3];
    else units[name] = match[3];
  }
  return { dropIns, units };
}

function seedUnits() {
  const rendered = renderSeed({}, { profile: 'release', repoRef: 'staging' });
  const firstBoot = YAML.parse(rendered.userData).autoinstall['user-data'];
  return Object.fromEntries(firstBoot.write_files
    .filter((file) => file.path.startsWith('/etc/systemd/system/'))
    .map((file) => [path.posix.basename(file.path), file.content]));
}

function payloadUnits() {
  const dir = path.resolve(__dirname, '..', '..', 'image-builder', 'payload', 'units');
  return Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

const SOURCES = {
  'the installer': bootstrapUnits().units,
  'the reconciler': renderUnits(),
  'the autoinstall seed': seedUnits(),
  'the image payload': payloadUnits(),
  'host patching': { 'mos-post-patch-check.service': renderPostPatchUnit('/opt/mos/repo') },
};

test('every unit MOS renders waits for the vault gate, or says why it need not', () => {
  const seen = new Set();
  for (const [source, units] of Object.entries(SOURCES)) {
    for (const [name, content] of Object.entries(units)) {
      seen.add(name);
      // Path and timer units only trigger a service, and the service carries
      // the rule.
      if (!name.endsWith('.service')) continue;
      if (name in VAULT_INDEPENDENT) {
        assert.doesNotMatch(content, GATED, `${name} from ${source} is listed as vault-independent but requires the gate; remove it from the list`);
        continue;
      }
      assert.match(content, GATED, `${name} from ${source} touches owner data and does not require mos-vault.service`);
      assert.match(content, /^After=.*\bmos-vault\.service\b/mu, `${name} from ${source} requires the gate but is not ordered after it`);
    }
  }
  for (const name of Object.keys(VAULT_INDEPENDENT)) {
    assert.ok(seen.has(name), `${name} is listed as vault-independent but no source renders it any more`);
  }
});

// A unit renderer that exists once and is written by two paths is the usual
// shape here; this pins the paths that must agree, so the installer and an
// update never disagree about which units wait.
test('the installer and the reconciler render the same set of gated MOS units', () => {
  const installer = Object.keys(bootstrapUnits().units).filter((name) => name.startsWith('mos-')).sort();
  const reconciler = Object.keys(renderUnits()).sort();
  assert.deepEqual(reconciler, installer);
});

// Docker's units are not MOS-owned, so their gate is a drop-in. The socket
// matters as much as the service: it is socket-activated, so anything touching
// /var/run/docker.sock would otherwise start a dockerd whose /var/lib/docker is
// the empty directory the vault mounts over.
test('dockerd and its socket wait for the gate on every path', () => {
  const { dropIns } = bootstrapUnits();
  for (const dropIn of ['docker.service.d', 'docker.socket.d']) {
    assert.match(dropIns[`/etc/systemd/system/${dropIn}/mos-vault.conf`] || '', GATED, `the installer does not gate ${dropIn}`);
  }
  const reconciler = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'reconcile-system.cjs'), 'utf8');
  assert.match(reconciler, /for \(const dropIn of \['docker\.service\.d', 'docker\.socket\.d'\]\) \{\n\s+installDir\([^\n]+\n\s+writeFile\([^\n]*vaultRequirement\(\)/u);
});

// Whether a machine has a vault is never a reason to leave the requirement out:
// the gate exits 0 where there is nothing to open. A conditional here is how one
// product grows a second, ungated shape that nobody meant to build.
test('no unit source decides the gate per machine', () => {
  const reconciler = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'reconcile-system.cjs'), 'utf8');
  assert.doesNotMatch(reconciler, /machineHasVault|runtimeConfig\.vault|config\.vault/u);
  assert.doesNotMatch(renderBootstrapPlan({}).sshBootstrap, /vault\.json/u);
});
