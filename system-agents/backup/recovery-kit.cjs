// What this machine remembers about its recovery key, and the sheet of paper an
// owner keeps.
//
// The record holds no key: a fingerprint says whether two machines hold the same
// one, `acknowledgedAt` says the owner has been shown it once, and `firstUsedAt`
// says this machine's key has already created or opened a repository — which is
// what decides whether a machine taking over someone else's backups adopts the
// entered key or adds its own beside it. Like everything else in the agent state
// directory it is root-only and machine-local, and never backed up.
//
// The kit is plain text on purpose. A PDF would be a dependency, and the file's
// whole job is to survive being printed, photographed, or copied onto paper by
// hand. It names the destinations so an owner who has lost the server still
// knows which bucket to point a new one at, and it never carries a storage
// credential: the provider's console is the credential's home.

const fs = require('node:fs');
const path = require('node:path');

const RECORD_FILENAME = 'recovery-key.json';
const RECORD_VERSION = 1;

class RecoveryKeyRecord {
  constructor({ agentStateDir, recordPath } = {}) {
    this.recordPath = recordPath || path.join(agentStateDir || '.', RECORD_FILENAME);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
      return {
        acknowledgedAt: parsed.acknowledgedAt || null,
        fingerprint: parsed.fingerprint || null,
        firstUsedAt: parsed.firstUsedAt || null,
      };
    } catch {
      return { acknowledgedAt: null, fingerprint: null, firstUsedAt: null };
    }
  }

  // The mode is reasserted after the write, because writeFileSync's mode only
  // applies to a file it creates.
  write(next) {
    const record = { ...this.read(), ...next };
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    fs.writeFileSync(this.recordPath, `${JSON.stringify({ ...record, version: RECORD_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.recordPath, 0o600);
    return record;
  }

  acknowledged() { return Boolean(this.read().acknowledgedAt); }

  // Once acknowledged the gate never returns, so an owner is asked to save their
  // key exactly once and never interrupted by it again.
  acknowledge(fingerprint, now = new Date()) {
    const current = this.read();
    if (current.acknowledgedAt && current.fingerprint === fingerprint) return current;
    return this.write({ acknowledgedAt: current.acknowledgedAt || now.toISOString(), fingerprint });
  }

  // Recorded the first time this machine's key creates or opens a repository.
  // Before that, a machine has nothing of its own to lose, which is what makes
  // adopting an entered key the right answer for a cold standby.
  noteFirstUse(now = new Date()) {
    if (this.read().firstUsedAt) return this.read();
    return this.write({ firstUsedAt: now.toISOString() });
  }

  // Taking over another server's backups on a machine that has never used its
  // own key: the entered key becomes this machine's, and the owner has plainly
  // just read it off their kit, so it counts as acknowledged.
  adopt(fingerprint, now = new Date()) {
    return this.write({ acknowledgedAt: now.toISOString(), fingerprint, firstUsedAt: now.toISOString() });
  }
}

function kitDate(now) {
  return now.toISOString().slice(0, 10);
}

function describeDestination(destination) {
  if (destination.kind !== 'bucket') return `  Drive: ${destination.label}`;
  return [
    `  Bucket: ${destination.label}`,
    `    Endpoint: ${destination.endpoint}`,
    `    Bucket name: ${destination.bucket}`,
    `    Folder: ${destination.folder || '(none)'}`,
    `    Region: ${destination.region || '(none)'}`,
  ].join('\n');
}

function recoveryKitFilename({ hostname, now = new Date() }) {
  const safeHost = String(hostname || 'server').toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'server';
  return `mos-recovery-kit-${safeHost}-${kitDate(now)}.txt`;
}

function recoveryKitText({ destinations = [], homeAddress, hostname, key, now = new Date() }) {
  return [
    'My Own Suite — recovery kit',
    '',
    `Made on ${kitDate(now)}`,
    `Server: ${hostname || 'unknown'}`,
    `Home address: ${homeAddress || 'unknown'}`,
    '',
    'Recovery key:',
    '',
    `    ${key}`,
    '',
    'Anyone who has this key and can reach your backups can read them. Keep it somewhere safe, and not only on this server.',
    '',
    'Backup destinations MOS knows right now:',
    ...(destinations.length ? destinations.map(describeDestination) : ['  (none connected yet)']),
    '',
    'How to recover onto another machine:',
    '',
    'Install MOS on the replacement machine and create an owner account on it so you can sign in.',
    'Open Backup & Restore, connect the same drive or the same bucket, and MOS will say the backups there were written by another server.',
    'Choose Enter recovery key, type the key above, and the restore points appear so you can restore one.',
    'When the restore finishes, sign in with the owner password from the server this kit came from, and re-apply your domain under HTTPS if you were using one.',
    "Your storage provider's console holds your access key; a new key for the same bucket works too.",
    '',
  ].join('\n');
}

module.exports = { RECORD_FILENAME, RecoveryKeyRecord, recoveryKitFilename, recoveryKitText };
