#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { renderBootstrapPlan } = require('./bootstrap-contract.cjs');

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
const placeholderLinuxPassword = 'change-me-before-build';
// The Hyper-V lab is a disposable VM that gets reinstalled constantly and that
// both humans and coding agents need to SSH into on demand. Making that depend
// on remembering to set LINUX_PASSWORD first is a trap, so the lab profile
// carries an obviously-fake fixed password instead. It is deliberately not a
// secret: it exists so nobody ever has to look one up.
const labLinuxPassword = 'admin1234';
const seedProfiles = ['lab', 'release'];
// Written by the first-boot init script, read by Suite Manager, deleted when the
// owner confirms they have saved the password.
const consoleLoginFileName = 'console-login.json';
// Left behind after the owner confirms. It is what tells the console banner to
// clear itself, and it lets Suite Manager tell "already handed over" apart from
// "this install never generated one".
const consoleLoginAcknowledgedFileName = 'console-login.acknowledged';
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

function assertSmokeRepoRefContainsRootLayout(repoRef) {
  const requiredPaths = [
    'package.json',
    'scripts/installers/bootstrap-contract.cjs',
    'infrastructure/caddy/Dockerfile',
    'suite-manager/backend/src/server/start.cjs',
  ];

  for (const requiredPath of requiredPaths) {
    const exists = spawnSync('git', ['cat-file', '-e', `${repoRef}:${requiredPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (exists.status !== 0) {
      throw new Error(
        `MOS_SMOKE_REPO_REF=${repoRef} does not contain '${requiredPath}'. ` +
        'Commit and push the root-layout branch, or set MOS_SMOKE_REPO_REF to a branch/tag that contains it.',
      );
    }
  }
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

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
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

// Generates the console password on the machine that will use it, on its own
// first boot. The alternative — deciding it while the ISO is built — cannot
// survive a published image: one build is flashed by every downloader, so the
// password would be shared by every install and extractable from the image.
// A fixed password takes the same path as a generated one rather than a
// shortcut around it. That is the point: the lab and smoke VMs then exercise the
// real handover — banner, Suite Manager panel, acknowledgement, cleanup — instead
// of testing a branch that no published install ever runs.
function renderConsoleLoginInitScript({ fixedPassword, runtimeUser, setupUrl, stateDir, username }) {
  const choosePassword = fixedPassword
    ? `# Fixed by the build profile, so this VM's login is predictable for humans
# and agents that have to reach it. Never used by a released image.
password=${shellQuote(fixedPassword)}`
    : `# No 0/1/l/o: this may have to be typed on a physical console, read off a screen.
raw="$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' < /dev/urandom 2>/dev/null | head -c 15 || true)"
if [ "\${#raw}" -ne 15 ]; then
  echo '[mos] Could not generate a console password from /dev/urandom.' >&2
  exit 1
fi
password="\${raw:0:5}-\${raw:5:5}-\${raw:10:5}"`;

  return `#!/usr/bin/env bash
set -euo pipefail

state_dir=${shellQuote(stateDir)}
handover="$state_dir/${consoleLoginFileName}"
acknowledged="$state_dir/${consoleLoginAcknowledgedFileName}"
username=${shellQuote(username)}
runtime_user=${shellQuote(runtimeUser)}

# A re-run must never rotate a password the owner may already have written down.
if [ -e "$handover" ] || [ -e "$acknowledged" ]; then
  exit 0
fi

${choosePassword}

printf '%s:%s\\n' "$username" "$password" | chpasswd
# The account ships locked. Unlocking it here is what makes the machine
# reachable at all, and only with the password chosen just above.
passwd -u "$username" >/dev/null 2>&1 || true

install -d -m 0755 "$state_dir"
umask 077
cat > "$handover.next" <<MOS_CONSOLE_LOGIN
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "password": "$password",
  "username": "$username",
  "version": 1
}
MOS_CONSOLE_LOGIN
chmod 0600 "$handover.next"
# This script runs as root, so root would own the file it leaves for a Suite
# Manager that runs as the unprivileged runtime user — which would then be shut
# out of the handover it is the only route for. Ownership is handed over before
# the file is in place, so it is never readable by nobody.
#
# On the ISO path the control-plane bootstrap runs after this and chowns the
# whole state root, which hid the problem. A machine installed from the prebuilt
# image ran that bootstrap at bake time and never chowns anything again.
chown "$runtime_user" "$handover.next"
mv "$handover.next" "$handover"

# Also on the physical console, because an owner who never opens Suite Manager
# from another machine would otherwise have no way to reach this one.
${renderConsoleIssueBlockWriter({ setupUrl })}
`;
}

const consoleIssueBeginMarker = '### My Own Suite server login (begin)';
const consoleIssueEndMarker = '### My Own Suite server login (end)';

function renderConsoleIssueBlockWriter({ setupUrl }) {
  return `cat >> /etc/issue <<MOS_CONSOLE_ISSUE

${consoleIssueBeginMarker}
  Server login for this machine (not your My Own Suite account):

      user      $username
      password  $password

  Save it, then confirm in Suite Manager at
  ${setupUrl}
  and these lines disappear from this screen.
${consoleIssueEndMarker}

MOS_CONSOLE_ISSUE`;
}

// Removes the password from the physical console once Suite Manager reports the
// owner has saved it. Suite Manager runs unprivileged and cannot edit /etc/issue
// itself, so it drops a sentinel file and this runs as root in response.
function renderConsoleLoginClearScript({ stateDir }) {
  return `#!/usr/bin/env bash
set -euo pipefail

state_dir=${shellQuote(stateDir)}
issue=/etc/issue

if [ -f "$issue" ]; then
  awk -v b=${shellQuote(consoleIssueBeginMarker)} -v e=${shellQuote(consoleIssueEndMarker)} \\
    'index($0, b) { skip = 1 } !skip { print } index($0, e) { skip = 0 }' "$issue" > "$issue.mos-next"
  mv "$issue.mos-next" "$issue"
  chmod 0644 "$issue"
fi

rm -f "$state_dir/${consoleLoginFileName}"

# One-shot by design: the handover happens once per install, so the watcher has
# no reason to survive it.
systemctl disable --now mos-console-login-clear.path >/dev/null 2>&1 || true
`;
}

function renderConsoleLoginUnits({ stateDir }) {
  return [
    {
      content: `[Unit]
Description=Clear the My Own Suite server login from the console banner

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mos-console-login-clear
`,
      path: '/etc/systemd/system/mos-console-login-clear.service',
      permissions: '0644',
    },
    {
      content: `[Unit]
Description=Watch for the owner confirming they saved the server login

[Path]
PathExists=${stateDir}/${consoleLoginAcknowledgedFileName}
Unit=mos-console-login-clear.service

[Install]
WantedBy=multi-user.target
`,
      path: '/etc/systemd/system/mos-console-login-clear.path',
      permissions: '0644',
    },
  ];
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
  const configuredPassword = String(config.LINUX_PASSWORD || '').trim();
  const explicitPassword = configuredPassword && configuredPassword !== placeholderLinuxPassword
    ? configuredPassword
    : '';
  const fixedPassword = explicitPassword || (profile === 'lab' ? labLinuxPassword : '');
  const consoleLoginHandover = fixedPassword ? 'preconfigured' : 'first-boot';

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
  ];
  firstBoot.runcmd = [
    // Before the control-plane bootstrap, so the machine is reachable even if
    // that fails: a box with no password and a broken install is a brick.
    ['bash', '/usr/local/sbin/mos-console-login-init'],
    renderBackupDiskSetupCommand(),
    ...(firstBoot.runcmd || []),
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
      ssh: { 'install-server': true, 'allow-pw': true },
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
  assertSmokeRepoRefContainsRootLayout(smokeRepoRef);
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
  assertSmokeRepoRefContainsRootLayout,
  consoleLoginAcknowledgedFileName,
  consoleLoginFileName,
  labLinuxPassword,
  loadSmokeConfig,
  parseEnvFile,
  renderSeed,
  resolveSeedProfile,
  resolveSmokeRepoRef,
};
