#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { DEFAULT_REPO_URL, renderBootstrapPlan } = require('./bootstrap-contract.cjs');
const { renderConsoleLoginClearScript, renderConsoleLoginInitScript, renderConsoleLoginUnits } = require('./console-login.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const configDir = path.join(repoRoot, 'infrastructure', 'self-host', 'autoinstall', 'installer-config');
const defaultConfigPath = path.join(configDir, 'selfhost-installer.env');
const defaultConfigTemplatePath = path.join(configDir, 'selfhost-installer.env.template');
const defaultOutputDir = path.join(repoRoot, '.mos-smoke', 'hyperv-usb', 'seed');
const defaultSmokeRepoRef = 'staging';
// Only MOS_-prefixed names: ambient shell variables (HOSTNAME in bash/MSYS,
// USERNAME on Windows) must never leak the build machine's identity into the seed.
const configEnvOverrides = {
  HOSTNAME: 'MOS_HOSTNAME',
  LINUX_PASSWORD: 'MOS_LINUX_PASSWORD',
  REALNAME: 'MOS_REALNAME',
  STACK_DOMAIN: 'MOS_STACK_DOMAIN',
  TIMEZONE: 'MOS_TIMEZONE',
  USERNAME: 'MOS_HYPERV_USERNAME',
};
// The Hyper-V lab is a disposable VM that gets reinstalled constantly and that
// both humans and coding agents need to SSH into on demand. Making that depend
// on remembering to set LINUX_PASSWORD first is a trap, so the lab profile
// carries an obviously-fake fixed password instead. It is deliberately not a
// secret: it exists so nobody ever has to look one up.
const labLinuxPassword = 'admin1234';
const seedProfiles = ['lab', 'release'];
// A locked account, not a password hash. An ISO published once is flashed by
// everyone who downloads it, so any hash committed here is the same hash on
// every MOS machine in the world. The account stays unopenable until the
// first-boot script sets a password this machine generated for itself.
const lockedInstallerPassword = '!';

// 'release' is the default everywhere, so the only way to get a fixed password
// into an image is to ask for it. `npm run installer:usb` — the command that
// builds a shareable ISO — never sets this.
function resolveSeedProfile(env = process.env) {
  const requested = String(env.MOS_SEED_PROFILE || '').trim().toLowerCase();
  if (!requested) return 'release';
  if (!seedProfiles.includes(requested)) {
    throw new Error(`Unknown MOS_SEED_PROFILE '${requested}'. Use one of: ${seedProfiles.join(', ')}.`);
  }
  return requested;
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function resolveSmokeRepoRef(env = process.env) {
  const explicit = String(env.MOS_SMOKE_REPO_REF || '').trim();
  if (explicit) return explicit;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD' && branch !== 'main') return branch;

  return defaultSmokeRepoRef;
}

// The guest clones MOS_REPO_URL and checks out MOS_REPO_REF, so the ref has to
// exist on the remote — a branch that only exists on this machine produces an
// image that cannot possibly install. This is checked separately from the
// content check below because they fail for opposite reasons and the local one
// cannot see the difference: `git cat-file` resolves against local objects, so
// an unpushed branch passes it and then costs ninety minutes of installer
// timeout to discover.
function assertSmokeRepoRefIsPushed(repoRef, repoUrl) {
  const remote = spawnSync('git', ['ls-remote', '--heads', '--tags', repoUrl, repoRef], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (remote.status !== 0) {
    // Being unable to ask is not the same as a missing ref; say which happened
    // rather than blaming the branch for the network.
    console.log(`[mos-smoke] Could not reach ${repoUrl} to confirm '${repoRef}' is pushed; continuing.`);
    return;
  }
  if (String(remote.stdout || '').trim()) return;
  // A full commit id never appears in ls-remote by name, so it is accepted when
  // some remote branch already contains it.
  if (/^[0-9a-f]{7,40}$/iu.test(repoRef) && git(['branch', '--remotes', '--contains', repoRef])) return;
  throw new Error(
    `The lab installs by cloning ${repoUrl} and checking out '${repoRef}', which does not exist there. ` +
    `Push it (git push -u origin ${repoRef}), or build the image against a pushed branch ` +
    '(MOS_SMOKE_REPO_REF=staging). The ref defaults to the branch you have checked out.',
  );
}

function parseEnvFile(filePath) {
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadSmokeConfig() {
  const values = fs.existsSync(defaultConfigTemplatePath) ? parseEnvFile(defaultConfigTemplatePath) : {};
  if (fs.existsSync(defaultConfigPath)) {
    Object.assign(values, parseEnvFile(defaultConfigPath));
  } else {
    console.log('[mos-smoke:hyperv-usb] No local installer config found; using defaults (no configuration is required).');
  }
  for (const [key, envKey] of Object.entries(configEnvOverrides)) {
    if (process.env[envKey]) values[key] = process.env[envKey];
  }
  return values;
}

function renderBackupDiskSetupCommand() {
  return String.raw`bash -lc 'set -euo pipefail
mountpoint -q /media/mos-backup && exit 0
root_source="$(findmnt -n -o SOURCE / || true)"
root_disk="$(lsblk -no PKNAME "$root_source" 2>/dev/null | head -n1 || true)"
if [ -z "$root_disk" ]; then root_disk="$(basename "$root_source" | sed "s/[0-9]*$//")"; fi
candidate=""
while read -r disk type; do
  [ "$type" = "disk" ] || continue
  [ "$(basename "$disk")" != "$root_disk" ] || continue
  if lsblk -nrpo MOUNTPOINT "$disk" | grep -q "/"; then continue; fi
  if lsblk -nrpo FSTYPE "$disk" | grep -q "."; then continue; fi
  candidate="$disk"
  break
done < <(lsblk -dnpo NAME,TYPE)
if [ -z "$candidate" ]; then
  echo "[mos-smoke:hyperv-usb] No empty second disk found for backup storage."
  exit 0
fi
mkfs.ext4 -F -L MOS_BACKUP "$candidate"
mkdir -p /media/mos-backup
uuid="$(blkid -s UUID -o value "$candidate")"
if [ -n "$uuid" ] && ! grep -q "$uuid" /etc/fstab; then
  printf "UUID=%s /media/mos-backup ext4 defaults,nofail 0 2\n" "$uuid" >> /etc/fstab
fi
mount /media/mos-backup
chmod 0777 /media/mos-backup
echo "[mos-smoke:hyperv-usb] Mounted disposable backup disk at /media/mos-backup."'
`;
}

function renderSeed(config, options = {}) {
  const hostname = config.HOSTNAME || 'mos';
  const username = config.USERNAME || 'mos';
  const realname = config.REALNAME || 'My Own Suite';
  const timezone = config.TIMEZONE || 'Europe/Copenhagen';
  const domain = config.STACK_DOMAIN || 'mos.home';
  // A fixed password is a development affordance: those ISOs are built for one
  // disposable machine by the person who will use it. The lab profile supplies
  // one so the Hyper-V VM is always reachable without anyone configuring
  // anything; an explicit LINUX_PASSWORD overrides it. Neither applies to the
  // default profile, which is the shape a shareable ISO must have.
  const profile = options.profile || resolveSeedProfile();
  const explicitPassword = String(config.LINUX_PASSWORD || '').trim();
  const fixedPassword = explicitPassword || (profile === 'lab' ? labLinuxPassword : '');
  const consoleLoginHandover = fixedPassword ? 'preconfigured' : 'first-boot';
  // The lab profile's way in once the image is finalized, which locks the
  // password: an SSH key. Refused outside that profile rather than omitted, so
  // no release seed can carry one by accident.
  const authorizedKeys = (options.authorizedKeys || []).map((key) => String(key).trim()).filter(Boolean);
  if (authorizedKeys.length > 0 && profile !== 'lab') {
    throw new Error('SSH keys can only be baked into the lab profile.');
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/u.test(hostname)) throw new Error('HOSTNAME is invalid.');
  if (!/^[a-z_][a-z0-9_-]*[$]?$/u.test(username)) throw new Error('USERNAME is invalid.');

  const smokeRepoRef = options.repoRef || resolveSmokeRepoRef();

  const plan = renderBootstrapPlan({
    domain,
    frontDoor: 'usb-autoinstall',
    disposableLab: profile === 'lab',
    repoRef: smokeRepoRef,
  });
  const suiteManagerStateDir = `${plan.config.stateRoot}/suite-manager`;
  const firstBoot = YAML.parse(plan.cloudInit);

  firstBoot.write_files = [
    ...(firstBoot.write_files || []),
    {
      content: renderConsoleLoginInitScript({
        fixedPassword,
        runtimeUser: plan.config.runtimeUser,
        setupUrl: plan.config.publicUrls.setup,
        stateDir: suiteManagerStateDir,
        username,
      }),
      path: '/usr/local/sbin/mos-console-login-init',
      permissions: '0755',
    },
    {
      content: renderConsoleLoginClearScript({ stateDir: suiteManagerStateDir }),
      path: '/usr/local/sbin/mos-console-login-clear',
      permissions: '0755',
    },
    ...renderConsoleLoginUnits({ stateDir: suiteManagerStateDir }),
    // Finalize locks the console password, which also leaves sudo with nothing
    // to accept, so the key above could read a broken machine but never repair
    // one. Tied to the same condition as the key itself, and the payload check
    // fails a release image that carries this file.
    ...(authorizedKeys.length > 0 ? [{
      content: `${username} ALL=(ALL) NOPASSWD:ALL\n`,
      path: '/etc/sudoers.d/90-mos-debug',
      permissions: '0440',
    }] : []),
  ];
  firstBoot.runcmd = [
    // Before the control-plane bootstrap, so the machine is reachable even if
    // that fails: a box with no password and a broken install is a brick.
    ['bash', '/usr/local/sbin/mos-console-login-init'],
    renderBackupDiskSetupCommand(),
    ...(firstBoot.runcmd || []),
    ['systemctl', 'enable', 'mos-console-login.service'],
    ['systemctl', 'enable', '--now', 'mos-console-login-clear.path'],
  ];

  const userData = {
    autoinstall: {
      version: 1,
      identity: {
        hostname,
        realname,
        username,
        password: lockedInstallerPassword,
      },
      locale: 'en_US.UTF-8',
      keyboard: { layout: 'us' },
      timezone,
      ssh: {
        'install-server': true,
        'allow-pw': true,
        ...(authorizedKeys.length > 0 ? { 'authorized-keys': authorizedKeys } : {}),
      },
      // No extra packages: anything listed here is downloaded from the Ubuntu
      // archive mid-install, making the offline-capable install phase fail on
      // machines without working DHCP/DNS. First boot has the network steps.
      storage: { layout: { name: 'direct' } },
      'user-data': firstBoot,
    },
  };

  return {
    consoleLoginHandover,
    linuxPassword: fixedPassword,
    linuxUsername: username,
    profile,
    metaData: `instance-id: mos-hyperv-usb\nlocal-hostname: ${hostname}\n`,
    plan,
    userData: `#cloud-config\n${YAML.stringify(userData, { lineWidth: 0 })}`,
  };
}

function main() {
  const smokeRepoRef = resolveSmokeRepoRef();
  assertSmokeRepoRefIsPushed(smokeRepoRef, DEFAULT_REPO_URL);
  const rendered = renderSeed(loadSmokeConfig(), { repoRef: smokeRepoRef });
  fs.rmSync(defaultOutputDir, { force: true, recursive: true });
  fs.mkdirSync(defaultOutputDir, { recursive: true });
  fs.writeFileSync(path.join(defaultOutputDir, 'user-data'), rendered.userData, 'utf8');
  fs.writeFileSync(path.join(defaultOutputDir, 'meta-data'), rendered.metaData, 'utf8');
  fs.writeFileSync(
    path.join(defaultOutputDir, 'seed-summary.json'),
    `${JSON.stringify(
      {
        consoleLoginHandover: rendered.consoleLoginHandover,
        home: rendered.plan.config.publicUrls.home,
        linuxPassword: rendered.linuxPassword,
        linuxUsername: rendered.linuxUsername,
        profile: rendered.profile,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`[mos-smoke:hyperv-usb] Rendered MOS Ubuntu autoinstall seed for ${smokeRepoRef}.`);
  console.log(`  Home: ${rendered.plan.config.publicUrls.home}`);
  console.log(`  Seed: ${defaultOutputDir}`);
  if (rendered.consoleLoginHandover === 'first-boot') {
    console.log(`  Server login: generated on the installed machine at first boot, for user ${rendered.linuxUsername}.`);
    console.log('  It is shown on that machine\'s console and in Suite Manager, and exists nowhere else.');
  } else {
    console.log(`  Server login: ${rendered.linuxUsername} / ${rendered.linuxPassword} (${rendered.profile} profile).`);
    console.log('  WARNING: this password is baked into the ISO. Never share or publish an image built this way.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-smoke:hyperv-usb] ${error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  assertSmokeRepoRefIsPushed,
  labLinuxPassword,
  loadSmokeConfig,
  parseEnvFile,
  renderSeed,
  resolveSeedProfile,
  resolveSmokeRepoRef,
};
