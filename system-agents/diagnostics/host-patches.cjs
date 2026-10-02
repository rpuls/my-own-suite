'use strict';

// What the host knows about its own patch state, as data.
//
// Parsing lives apart from the commands that produce it so it can be tested
// against recorded output rather than only against a live machine: the shapes
// that matter here — nothing pending, a security patch waiting, a reboot asked
// for by a kernel — are exactly the ones that are awkward to arrange on demand.

// `apt-get --just-print dist-upgrade` prints one line per package it would
// touch, with the archive it would come from in the parentheses:
//
//   Inst libssl3 [3.0.13-0ubuntu3.3] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-security [amd64])
//
// The pocket in that origin is the whole point: MOS only installs from
// `-security`, so a count that did not separate the pockets would promise the
// owner that MOS is about to install things it will never touch.
//
// This is the security-pocket candidate apt would install, which is a close
// proxy for what unattended-upgrades will do and not a promise of it: where a
// package has a newer version in -updates than in -security, apt names the
// -updates one and it lands in the other bucket, while unattended-upgrades
// would still take the -security version. The full simulation goes into the
// Advanced panel underneath the count for exactly this reason.
const INST_LINE = /^Inst\s+(\S+)\s+(?:\[[^\]]*\]\s+)?\(([^)]*)\)/u;

function parseUpgradableSimulation(raw) {
  const other = [];
  const security = [];
  for (const line of String(raw || '').split('\n')) {
    const match = INST_LINE.exec(line.trim());
    if (!match) continue;
    (/-security\b/u.test(match[2]) ? security : other).push(match[1]);
  }
  return { other: other.sort(), security: security.sort() };
}

// `apt-config dump` prints the configuration apt itself would act on, from every
// file in apt.conf.d in the order apt reads them. Reporting that rather than the
// file MOS wrote is what makes an owner-managed server tell the truth about
// itself, and what would catch a MOS file that lost an argument to something
// later in the directory.
function parseAptConfigDump(raw) {
  const allowedOrigins = [];
  const originsPattern = [];
  let automaticReboot = null;
  let periodicUnattended = null;
  let blacklist = [];
  for (const line of String(raw || '').split('\n')) {
    const match = /^(\S+)\s+"(.*)";\s*$/u.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key.startsWith('Unattended-Upgrade::Allowed-Origins::')) allowedOrigins.push(value);
    else if (key.startsWith('Unattended-Upgrade::Origins-Pattern::')) originsPattern.push(value);
    else if (key.startsWith('Unattended-Upgrade::Package-Blacklist::')) blacklist.push(value);
    else if (key === 'Unattended-Upgrade::Automatic-Reboot') automaticReboot = /^(?:true|1|yes)$/iu.test(value);
    else if (key === 'APT::Periodic::Unattended-Upgrade') periodicUnattended = value !== '0';
  }
  // An empty value is how apt renders a cleared list's placeholder entry.
  blacklist = blacklist.filter(Boolean);
  return {
    allowedOrigins: allowedOrigins.filter(Boolean),
    automaticReboot,
    heldPackages: blacklist,
    originsPattern: originsPattern.filter(Boolean),
    periodicUnattended,
  };
}

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/u;

function timestampOf(line) {
  const match = LOG_TIMESTAMP.exec(line);
  return match ? `${match[1]}T${match[2]}` : null;
}

// unattended-upgrades writes a plain log. Two facts are worth lifting out of it:
// the last time it ran at all, which is what the Updates screen means by "last
// checked", and the last time it actually installed something, which is what an
// owner asking "has this ever done anything" is looking for.
function parseUnattendedLog(raw) {
  let lastRunAt = null;
  let lastInstallAt = null;
  let lastInstalledPackages = [];
  let pendingPackages = [];
  for (const line of String(raw || '').split('\n')) {
    if (/Starting unattended upgrades script/u.test(line)) lastRunAt = timestampOf(line) || lastRunAt;
    const upgrading = /Packages that (?:will be|were) upgraded:\s*(.*)$/u.exec(line);
    if (upgrading) pendingPackages = upgrading[1].split(/\s+/u).filter(Boolean);
    if (/All upgrades installed/u.test(line)) {
      lastInstallAt = timestampOf(line) || lastInstallAt;
      lastInstalledPackages = pendingPackages;
    }
  }
  return { lastInstallAt, lastInstalledPackages, lastRunAt };
}

// `/var/run/reboot-required.pkgs` accumulates one package name per line and
// repeats them, because each upgrade appends without checking.
function parseRebootPackages(raw) {
  return [...new Set(String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

module.exports = {
  parseAptConfigDump,
  parseRebootPackages,
  parseUnattendedLog,
  parseUpgradableSimulation,
};
