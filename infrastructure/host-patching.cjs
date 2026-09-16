'use strict';

// Ubuntu's own security patches, on the host MOS runs on.
//
// Written from here by both paths that own host state — the installer at first
// boot and `reconcile-system.cjs` on every managed update — for the same reason
// the journald config is: a setting only the installer applied would reach
// reflashed machines and no others.
//
// The pinning is the entire safety argument. Only the security pocket is
// allowed, so everything that could plausibly break the suite is out of scope by
// construction: Docker and containerd come from Docker's repository, Node from
// NodeSource, Caddy is a binary this repo builds, and every app runs in a
// container carrying its own userland, so a host libssl patch cannot change a
// byte inside an app image. What is left is the kernel, systemd, the system
// libraries the host agents' Node links against, and the storage and network
// plumbing — four things, not "Ubuntu".

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APT_CONF_DIR = '/etc/apt/apt.conf.d';
// Later than the distro's own 50unattended-upgrades and 20auto-upgrades, which
// is what makes these the effective answer: apt reads the directory in name
// order and the last assignment of a scalar wins.
const SECURITY_CONFIG_PATH = `${APT_CONF_DIR}/52mos-security-updates`;
const PERIODIC_CONFIG_PATH = `${APT_CONF_DIR}/52mos-auto-upgrades`;
const HOLDS_CONFIG_PATH = `${APT_CONF_DIR}/53mos-package-holds`;
const DISTRO_CONFIG_PATH = `${APT_CONF_DIR}/50unattended-upgrades`;
const STOCK_CONFIG_PATH = '/usr/share/unattended-upgrades/50unattended-upgrades';
const UNATTENDED_BINARY_PATH = '/usr/bin/unattended-upgrade';
// Written by dpkg when an installed package needs one; the only signal there is.
const REBOOT_REQUIRED_PATH = '/var/run/reboot-required';
const MOS_CONFIG_PATHS = Object.freeze([SECURITY_CONFIG_PATH, PERIODIC_CONFIG_PATH, HOLDS_CONFIG_PATH]);

const POST_PATCH_UNIT = 'mos-post-patch-check.service';
const POST_PATCH_UNIT_PATH = `/etc/systemd/system/${POST_PATCH_UNIT}`;

// A file that sets one of these is claiming the unattended-upgrades policy. The
// other APT::Periodic keys are not a claim: stock Ubuntu ships 10periodic with
// the list-refresh cadence in it, on every server, chosen by nobody.
const UNATTENDED_KEY = /^\s*(?:#clear\s+)?(?:Unattended-Upgrade::|APT::Periodic::Unattended-Upgrade)/mu;

function stateDirFor(stateRoot) {
  return path.join(stateRoot, 'host-patches');
}

function enablementStatePath(stateRoot) {
  return path.join(stateDirFor(stateRoot), 'enablement.json');
}

function healthStatePath(stateRoot) {
  return path.join(stateDirFor(stateRoot), 'health.json');
}

function renderSecurityConfig() {
  return `// Managed by My Own Suite. Rewritten on every platform update; edits are lost.
//
// Ubuntu security patches only. Nothing from -updates, -backports or any
// third-party repository is installed unattended, because the software the suite
// actually runs on does not come from this channel and must not be swapped out
// from under it between MOS releases.

// The distro's file and anything before it also contribute origins, and apt
// unions the lists. Clearing both first is what makes the single entry below the
// only thing unattended-upgrades will install from.
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;

Unattended-Upgrade::Allowed-Origins {
        "\${distro_id}:\${distro_codename}-security";
};

// MOS never restarts the server on its own. A patch that needs one says so
// through /var/run/reboot-required, Suite Manager reports it, and the owner
// decides when. See docs/guides/updates.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";

// Keeps the previous kernel installed, which is the whole rollback story for a
// host that will not boot: GRUB's Advanced options still offers it. Ubuntu's
// autoremove rules protect the running, newest and previous kernels, so this
// removes only the ones behind those — without it /boot fills up, which is its
// own way to wedge a machine.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";

// One package at a time, so an interrupted run leaves dpkg with less to
// reconcile than a single transaction would.
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::SyslogEnable "true";
Unattended-Upgrade::Mail "";
`;
}

function renderPeriodicConfig() {
  return `// Managed by My Own Suite. Rewritten on every platform update; edits are lost.
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
`;
}

// Runs at boot and after every unattended run. What it decides is in
// system-agents/host-patches/post-patch-check.cjs; this only says when.
//
// Not ordered after multi-user.target, although it is wanted by it: a target
// implicitly orders itself after everything it wants, so that pair is a cycle
// systemd breaks by dropping a job from the boot. Docker is the last thing the
// suite's units wait for, and the check itself waits for the rest to settle.
function renderPostPatchUnit(repoRoot, stateRoot = '/var/lib/mos') {
  return `[Unit]
Description=MOS post-patch health check
After=network-online.target docker.service apt-daily-upgrade.service
Documentation=https://myownsuite.org/docs/guides/updates/

[Service]
Type=oneshot
WorkingDirectory=${repoRoot}
Environment=NODE_ENV=production
Environment=MOS_STATE_ROOT=${stateRoot}
ExecStart=/usr/bin/node ${repoRoot}/system-agents/host-patches/post-patch-check.cjs

[Install]
WantedBy=multi-user.target apt-daily-upgrade.service
`;
}

// Package names go into an unattended-upgrades blacklist, which is a list of
// regular expressions. Anchored and escaped so a hold names one package and
// cannot become a pattern that matches half the archive.
function renderHoldsConfig(packages = []) {
  const entries = packages.map((name) => `        "^${String(name).replace(/[.+*?^$()[\]{}|\\]/gu, '\\$&')}$";`);
  return `// Managed by My Own Suite from the signed advisory feed. Rewritten on refresh.
#clear Unattended-Upgrade::Package-Blacklist;
Unattended-Upgrade::Package-Blacklist {
${entries.join('\n')}${entries.length ? '\n' : ''}};
`;
}

function normalizeConfigText(text) {
  return String(text).replace(/\r\n?/gu, '\n').trimEnd();
}

// Evidence that the owner runs their own unattended-upgrades policy, as a
// sentence to show them rather than a boolean.
//
// The distro's own 50unattended-upgrades is not evidence: every Ubuntu carries
// it, unmodified, whether or not anybody chose anything. An edited copy is, and
// so is any other file in apt.conf.d that sets one of these keys. Taking either
// of those over would be MOS overwriting a decision somebody made on purpose,
// on a VPS it does not own.
function ownerManagedReason({ distroConfig = null, otherConfigs = [], stockConfig = null } = {}) {
  if (typeof distroConfig === 'string' && typeof stockConfig === 'string'
    && normalizeConfigText(distroConfig) !== normalizeConfigText(stockConfig)) {
    return `${DISTRO_CONFIG_PATH} has been edited on this server, so MOS left the policy alone.`;
  }
  const claimed = otherConfigs.find((entry) => UNATTENDED_KEY.test(String(entry?.text || '')));
  if (claimed) return `${claimed.path} already sets an unattended-upgrades policy, so MOS left it alone.`;
  return null;
}

function readTextOrNull(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

// Everything in apt.conf.d that is neither ours nor the two files the distro
// ships, so a policy somebody else put there is found wherever they put it.
function readOtherConfigs() {
  let names = [];
  try { names = fs.readdirSync(APT_CONF_DIR); } catch { return []; }
  const ignored = new Set([...MOS_CONFIG_PATHS.map((file) => path.basename(file)), path.basename(DISTRO_CONFIG_PATH), '20auto-upgrades']);
  return names
    .filter((name) => !ignored.has(name))
    .map((name) => ({ path: path.join(APT_CONF_DIR, name), text: readTextOrNull(path.join(APT_CONF_DIR, name)) || '' }));
}

function detectOwnerManagedConfig() {
  return ownerManagedReason({
    distroConfig: readTextOrNull(DISTRO_CONFIG_PATH),
    otherConfigs: readOtherConfigs(),
    stockConfig: readTextOrNull(STOCK_CONFIG_PATH),
  });
}

function readEnablementState(stateRoot = '/var/lib/mos') {
  try { return JSON.parse(fs.readFileSync(enablementStatePath(stateRoot), 'utf8')); } catch { return null; }
}

function writeEnablementState(stateRoot, state) {
  const file = enablementStatePath(stateRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.chmodSync(file, 0o644);
}

// Applies the policy, or records why it did not. Never throws: a machine that
// cannot install the package is a machine that goes on running unpatched, which
// is worth reporting on the Updates screen and is not worth failing an install
// or a platform update over.
function applyHostPatching({ dryRun = false, log = () => {}, repoRoot = path.resolve(__dirname, '..'), stateRoot = '/var/lib/mos' } = {}) {
  const at = new Date().toISOString();
  const run = (command, args) => {
    log(`${command} ${args.join(' ')}`);
    if (dryRun) return '';
    return execFileSync(command, args, { encoding: 'utf8', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const write = (file, content) => {
    if (dryRun) { log(`would write ${file}`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    fs.chmodSync(file, 0o644);
  };
  const record = (state) => {
    if (dryRun) { log(`would record host patching as ${state.managedBy}`); return state; }
    writeEnablementState(stateRoot, state);
    return state;
  };

  // Asked before the package is installed, because installing it is what puts
  // the distro's own file on disk and there would be nothing left to compare.
  const ownerReason = detectOwnerManagedConfig();
  if (ownerReason) {
    log(`host patching: ${ownerReason}`);
    return record({ at, managedBy: 'owner', reason: ownerReason });
  }

  // Ubuntu Server ships the package, so this is for a stripped image. It is
  // skipped rather than repeated when the binary is there: a managed update
  // must not queue behind the dpkg lock of an unattended run in progress, or
  // fail because apt could not reach an archive it has nothing to fetch from.
  if (!fs.existsSync(UNATTENDED_BINARY_PATH)) {
    try {
      run('apt-get', ['install', '-y', '--no-install-recommends', 'unattended-upgrades']);
    } catch (error) {
      const reason = `unattended-upgrades could not be installed: ${error.message}`;
      log(`host patching: ${reason}`);
      return record({ at, managedBy: 'none', reason });
    }
  }

  write(SECURITY_CONFIG_PATH, renderSecurityConfig());
  write(PERIODIC_CONFIG_PATH, renderPeriodicConfig());
  write(POST_PATCH_UNIT_PATH, renderPostPatchUnit(repoRoot, stateRoot));

  // Best-effort from here: the policy is on disk and correct, and a timer that
  // refuses to enable is worth reporting rather than worth failing an update
  // over. The Updates screen reads the effective configuration, not this.
  for (const [command, args] of [
    ['systemctl', ['daemon-reload']],
    ['systemctl', ['enable', '--now', 'apt-daily.timer', 'apt-daily-upgrade.timer']],
    ['systemctl', ['enable', POST_PATCH_UNIT]],
  ]) {
    try { run(command, args); } catch (error) { log(`host patching: ${command} failed (${error.message}); continuing`); }
  }

  log('host patching: Ubuntu security updates are applied automatically');
  return record({ at, managedBy: 'mos', reason: null });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  applyHostPatching({ dryRun, log: (message) => process.stdout.write(`[mos:host-patching] ${message}\n`) });
}

module.exports = {
  APT_CONF_DIR,
  DISTRO_CONFIG_PATH,
  HOLDS_CONFIG_PATH,
  MOS_CONFIG_PATHS,
  PERIODIC_CONFIG_PATH,
  POST_PATCH_UNIT,
  POST_PATCH_UNIT_PATH,
  REBOOT_REQUIRED_PATH,
  SECURITY_CONFIG_PATH,
  STOCK_CONFIG_PATH,
  UNATTENDED_BINARY_PATH,
  applyHostPatching,
  detectOwnerManagedConfig,
  healthStatePath,
  ownerManagedReason,
  readEnablementState,
  renderHoldsConfig,
  renderPeriodicConfig,
  renderPostPatchUnit,
  renderSecurityConfig,
  stateDirFor,
};
