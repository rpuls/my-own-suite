const fs = require('node:fs');
const path = require('node:path');

// The storage module's record: every drive, shared folder and bucket MOS knows,
// keyed by its identity, with the owner's name for it and what claims it. Bucket
// and share entries carry their keys, so the file is root-only, machine-local and
// never in a backup.

const RECORD_VERSION = 2;
// A process holds the lock for one synchronous read and write, so a lock this old
// belongs to one that died holding it.
const STALE_LOCK_MS = 5_000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const MAX_NAME_LENGTH = 60;

function emptyRecord() {
  return { buckets: {}, drives: {}, shares: {}, version: RECORD_VERSION };
}

function normalizeName(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

class StorageRegistry {
  constructor({ registryPath }) {
    this.registryPath = registryPath;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      if (parsed?.version !== RECORD_VERSION) return emptyRecord();
      return { buckets: parsed.buckets || {}, drives: parsed.drives || {}, shares: parsed.shares || {}, version: RECORD_VERSION };
    } catch {
      return emptyRecord();
    }
  }

  // Drives and shares are written by the app agent and its plug-in unit, buckets
  // by the backup agent that holds their keys; each in a process of its own.
  update(change) {
    const lock = `${this.registryPath}.lock`;
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    for (;;) {
      try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true }); } catch {}
        Atomics.wait(LOCK_WAIT, 0, 0, 20);
      }
    }
    try {
      const record = this.read();
      const answer = change(record);
      const temporary = `${this.registryPath}.${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.registryPath);
      return answer;
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  // A shared folder is a drive to everything that keeps files on one.
  drive(driveId) {
    const { drives, shares } = this.read();
    return drives[driveId] || shares[driveId] || null;
  }

  // Fields set to undefined are removed; a drive MOS does not remember is left alone.
  recordDrive(driveId, fields) {
    this.update((record) => {
      const map = holderOf(record, driveId);
      if (!map) return;
      const next = { ...map[driveId], ...fields };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
      map[driveId] = next;
    });
  }

  // A drive or share nothing claims any more, forgotten so it is neither listed
  // nor opened again. One an app still reads stays.
  forgetDrive(driveId) {
    return this.update((record) => {
      const map = holderOf(record, driveId);
      if (!map || map[driveId].apps?.length) return false;
      delete map[driveId];
      return true;
    });
  }

  bucketList() {
    return Object.values(this.read().buckets);
  }

  // The owner's name for any storage. An empty name gives a drive its own label
  // back. Naming a drive does not make MOS keep anything on it.
  rename(id, value) {
    const name = normalizeName(value);
    return this.update(({ buckets, drives, shares }) => {
      const named = buckets[id] || shares[id];
      if (named) {
        if (!name) throw new Error('Give it a name.');
        named.label = name;
        return name;
      }
      const next = { ...drives[id] };
      if (name) next.name = name;
      else delete next.name;
      drives[id] = next;
      return name;
    });
  }
}

function holderOf({ drives, shares }, id) {
  if (drives[id]) return drives;
  return shares[id] ? shares : null;
}

// What leaves an agent about a bucket. The access key ID stays: it is an identifier
// rather than a secret, and without it an owner with several keys cannot tell which
// one a bucket is using.
function publicBucket(record) {
  return {
    accessKeyId: record.accessKeyId,
    bucket: record.bucket,
    createdAt: record.createdAt || null,
    endpoint: record.endpoint,
    folder: record.folder || '',
    id: record.id,
    label: record.label,
    region: record.region || '',
  };
}

// A drive MOS lists while it is away: an app reads it, or it is kept open for
// its files — browsed once, or left holding an uninstalled app's folders.
function isRememberedDrive(entry) {
  return Boolean(entry && (entry.apps?.length || entry.keepOpen === true));
}

module.exports = { StorageRegistry, isRememberedDrive, publicBucket };
