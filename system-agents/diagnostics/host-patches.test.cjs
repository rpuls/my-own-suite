const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseAptConfigDump,
  parseRebootPackages,
  parseUnattendedLog,
  parseUpgradableSimulation,
} = require('./host-patches.cjs');

// Recorded from `apt-get --just-print dist-upgrade` on a machine behind on both
// pockets. The mix is the point: a count that did not separate them would tell
// an owner MOS is about to install things it will never touch.
const SIMULATION = `NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
Reading package lists...
Building dependency tree...
Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])
Inst linux-image-generic [6.8.0-45.45] (6.8.0-48.48 Ubuntu:24.04/noble-security [amd64])
Inst vim-common [2:9.1.0016-1ubuntu7.3] (2:9.1.0016-1ubuntu7.5 Ubuntu:24.04/noble-updates [all])
Conf libssl3t64 (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])
`;

test('only the security pocket counts towards what MOS will install', () => {
  const { other, security } = parseUpgradableSimulation(SIMULATION);
  assert.deepEqual(security, ['libssl3t64', 'linux-image-generic']);
  assert.deepEqual(other, ['vim-common']);
});

test('a machine with nothing to do reports nothing, not an unreadable state', () => {
  assert.deepEqual(parseUpgradableSimulation('Reading package lists...\nBuilding dependency tree...\n'), { other: [], security: [] });
  assert.deepEqual(parseUpgradableSimulation(''), { other: [], security: [] });
});

test('the effective apt configuration is read as apt itself resolved it', () => {
  const config = parseAptConfigDump(`APT::Periodic::Enable "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Allowed-Origins "";
Unattended-Upgrade::Allowed-Origins:: "Ubuntu:noble-security";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Package-Blacklist "";
Unattended-Upgrade::Package-Blacklist:: "^linux-image-generic$";
`);
  assert.deepEqual(config.allowedOrigins, ['Ubuntu:noble-security']);
  assert.deepEqual(config.originsPattern, []);
  assert.deepEqual(config.heldPackages, ['^linux-image-generic$']);
  assert.equal(config.automaticReboot, false);
  assert.equal(config.periodicUnattended, true);
});

// A server where the owner runs their own policy: -updates is allowed and
// automatic reboot is on. MOS reports that rather than correcting it.
test('an owner policy that allows more than the security pocket is reported as it is', () => {
  const config = parseAptConfigDump(`Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=\${distro_codename},label=Debian-Security";
Unattended-Upgrade::Origins-Pattern:: "o=Ubuntu,a=\${distro_codename}-updates";
Unattended-Upgrade::Automatic-Reboot "true";
APT::Periodic::Unattended-Upgrade "0";
`);
  assert.equal(config.originsPattern.length, 2);
  assert.equal(config.automaticReboot, true);
  assert.equal(config.periodicUnattended, false);
});

test('the unattended log gives up when it last ran and what it last installed', () => {
  const parsed = parseUnattendedLog(`2026-09-14 06:11:02,113 INFO Starting unattended upgrades script
2026-09-14 06:11:03,004 INFO No packages found that can be upgraded unattended and no pending auto-removals
2026-09-15 06:12:33,123 INFO Starting unattended upgrades script
2026-09-15 06:12:40,456 INFO Packages that will be upgraded: libssl3t64 linux-image-generic
2026-09-15 06:12:55,789 INFO All upgrades installed
2026-09-16 06:10:01,001 INFO Starting unattended upgrades script
2026-09-16 06:10:02,002 INFO No packages found that can be upgraded unattended and no pending auto-removals
`);
  assert.equal(parsed.lastRunAt, '2026-09-16T06:10:01');
  assert.equal(parsed.lastInstallAt, '2026-09-15T06:12:55');
  assert.deepEqual(parsed.lastInstalledPackages, ['libssl3t64', 'linux-image-generic']);
});

test('a log from a server that has never installed anything says so', () => {
  const parsed = parseUnattendedLog('2026-09-16 06:10:01,001 INFO Starting unattended upgrades script\n');
  assert.equal(parsed.lastRunAt, '2026-09-16T06:10:01');
  assert.equal(parsed.lastInstallAt, null);
  assert.deepEqual(parsed.lastInstalledPackages, []);
});

// Every upgrade appends without checking, so the file repeats itself.
test('the packages that asked for a restart are named once each', () => {
  assert.deepEqual(parseRebootPackages('linux-base\nlinux-image-6.8.0-48-generic\nlinux-base\n\n'), ['linux-base', 'linux-image-6.8.0-48-generic']);
  assert.deepEqual(parseRebootPackages(null), []);
});
