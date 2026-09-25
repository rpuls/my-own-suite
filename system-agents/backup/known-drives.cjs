'use strict';

// The drives MOS has backed up to, including the ones that are not here.
//
// A backup destination that is plugged in can be erased by anything that gets
// root on this server, ransomware included. A drive in a drawer cannot, and
// that is the only protection against ransomware an owner can actually perform
// — no bucket setting MOS can reach from here comes close, because any
// protection MOS can undo, an attacker on this machine can undo.
//
// So MOS has to be able to talk about a drive that is not attached: which one
// it was, when it was last written to, and that it is currently out of reach.
// Nothing else in the agent can, because everything else asks the filesystem
// what is mounted right now.
//
// Drives are remembered by the UUID of the filesystem on them rather than by
// where they happened to be mounted: a mount path is a fact about this boot,
// and the whole point here is to survive being unplugged. A drive whose
// filesystem MOS cannot identify is simply not remembered, which is right — it
// would otherwise come back as a different drive every time.

const fs = require('node:fs');
const path = require('node:path');

const RECORD_FILENAME = 'known-drives.json';
const RECORD_VERSION = 1;
// How stale "last seen" is allowed to get before the record is rewritten for
// that alone. Every status poll reconciles, the Backups screen polls every few
// seconds, and a write per poll on the disk the machine boots from adds up over
// a year. Nothing on screen reads a drawer drive's last-seen time more finely
// than this.
const SEEN_INTERVAL_MS = 15 * 60 * 1000;

// Anything but a drive's last-seen time is written the moment it changes; a
// last-seen time that has only moved on is written when it has drifted far
// enough to be worth a disk write. See SEEN_INTERVAL_MS.
function worthWriting(before, next, now) {
  const withoutSeen = (list) => JSON.stringify(list.map(({ lastSeenAt, ...rest }) => rest));
  if (withoutSeen(before) !== withoutSeen(next)) return true;
  const recorded = new Map(before.map((drive) => [drive.fsUuid, drive.lastSeenAt]));
  return next.some((drive) => drive.lastSeenAt !== recorded.get(drive.fsUuid)
    && now - new Date(recorded.get(drive.fsUuid) || 0) >= SEEN_INTERVAL_MS);
}

class KnownDrives {
  constructor({ agentStateDir, recordPath } = {}) {
    this.recordPath = recordPath || path.join(agentStateDir || '.', RECORD_FILENAME);
  }

  list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
      return (Array.isArray(parsed.drives) ? parsed.drives : []).filter((drive) => drive && drive.fsUuid);
    } catch {
      return [];
    }
  }

  write(drives) {
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    fs.writeFileSync(this.recordPath, `${JSON.stringify({ drives, version: RECORD_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.recordPath, 0o600);
    return drives;
  }

  forget(fsUuid) {
    return this.write(this.list().filter((drive) => drive.fsUuid !== fsUuid));
  }

  /**
   * Records what is attached now and answers with what is not.
   *
   * Only a drive that holds a backup is remembered. Every drive an owner ever
   * plugs into the machine would otherwise end up on the list, and a list that
   * includes the camera card somebody borrowed is a list nobody reads.
   *
   * @param {object} options
   * @param {Array} options.attached disk destinations as the listing sees them
   * @param {(id: string) => string|null} options.lastBackupAt newest restore point per destination
   */
  reconcile({ attached = [], lastBackupAt = () => null, now = new Date() } = {}) {
    const seenAt = now.toISOString();
    const before = this.list();
    const drives = new Map(before.map((drive) => [drive.fsUuid, drive]));

    for (const entry of attached) {
      if (!entry.fsUuid) continue;
      const backedUpAt = lastBackupAt(entry.id);
      const known = drives.get(entry.fsUuid);
      if (!known && !backedUpAt) continue;
      drives.set(entry.fsUuid, {
        fsUuid: entry.fsUuid,
        id: entry.id,
        label: entry.label || known?.label || entry.id,
        // Kept from before when a drive is attached but MOS cannot read its
        // repository right now: a locked or unreadable drive has not lost the
        // backup it was holding yesterday.
        lastBackupAt: backedUpAt || known?.lastBackupAt || null,
        lastSeenAt: seenAt,
      });
    }
    const next = [...drives.values()];
    if (worthWriting(before, next, now)) this.write(next);

    const present = new Set(attached.map((entry) => entry.fsUuid).filter(Boolean));
    return next.filter((drive) => !present.has(drive.fsUuid));
  }
}

module.exports = { KnownDrives, RECORD_FILENAME };
