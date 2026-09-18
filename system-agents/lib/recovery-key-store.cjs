'use strict';

// The machine's recovery key, on disk: one key, three files, one owner.
//
// The key opens the encrypted disk and every backup this machine writes, so the
// vault agent and the backup agent both need it and both are root on one host.
// Rather than each knowing the other's paths, the files and their rules live
// here and both agents call in:
//
// - the key file, inside the vault, root-only, the operational copy the owner
//   also holds on paper;
// - the record beside it, which says whether the owner has confirmed they hold
//   the key, whether it was adopted from another server, and when it was last
//   rotated or first used;
// - the escrow, on the plaintext partition, a copy of the key that exists only
//   between the vault's creation and the owner's confirmation. It is what lets a
//   vault refuse to open only once its owner holds the key, and it is destroyed
//   the moment the record says they do.
//
// Nothing here knows about LUKS or restic. The engine keeps its own bookkeeping
// of superseded repository passwords beside the key file; the vault agent keeps
// its descriptor. What they share is exactly this.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { generate } = require('../backup/recovery-key.cjs');

// The backup agent's state directory, which the vault mounts over: a key that
// opens the vault is kept inside the vault it opens, and only ever needed once
// the vault is already open.
const STATE_DIR = '/var/lib/mos/backup-agent';
const KEY_FILENAME = 'engine-key';
const RECORD_FILENAME = 'recovery-key.json';
// Plaintext side, because it has to be readable while the vault is closed.
const ESCROW_PATH = '/etc/mos/vault-recovery-key';
const RECORD_VERSION = 1;

const HANDOVER = Object.freeze({ DONE: 'done', PENDING: 'pending' });

const EMPTY_RECORD = Object.freeze({ acknowledgedAt: null, adoptedAt: null, fingerprint: null, firstUsedAt: null, rotatedAt: null });

function writeSecretFile(filePath, value, dirMode) {
  fs.mkdirSync(path.dirname(filePath), { mode: dirMode, recursive: true });
  fs.writeFileSync(filePath, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode only applies to a file it creates.
  fs.chmodSync(filePath, 0o600);
}

function readSecretFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

class RecoveryKeyStore {
  constructor({ escrowPath = ESCROW_PATH, stateDir = STATE_DIR } = {}) {
    this.keyPath = path.join(stateDir, KEY_FILENAME);
    this.recordPath = path.join(stateDir, RECORD_FILENAME);
    this.escrowPath = escrowPath;
  }

  readKey() {
    return readSecretFile(this.keyPath);
  }

  writeKey(key) {
    writeSecretFile(this.keyPath, key, 0o700);
    return key;
  }

  // The key this machine holds, made on first use if it has none yet.
  ensureKey() {
    return this.readKey() || this.writeKey(generate().key);
  }

  readRecord() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
      return {
        acknowledgedAt: parsed.acknowledgedAt || null,
        adoptedAt: parsed.adoptedAt || null,
        fingerprint: parsed.fingerprint || null,
        firstUsedAt: parsed.firstUsedAt || null,
        rotatedAt: parsed.rotatedAt || null,
      };
    } catch {
      return { ...EMPTY_RECORD };
    }
  }

  writeRecord(next) {
    const record = { ...this.readRecord(), ...next };
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    fs.writeFileSync(this.recordPath, `${JSON.stringify({ ...record, version: RECORD_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.recordPath, 0o600);
    return record;
  }

  acknowledged() {
    return Boolean(this.readRecord().acknowledgedAt);
  }

  // Once acknowledged the gate never returns, so an owner is asked to save their
  // key exactly once and never interrupted by it again.
  acknowledge(fingerprint, now = new Date()) {
    const current = this.readRecord();
    if (current.acknowledgedAt && current.fingerprint === fingerprint) return current;
    return this.writeRecord({ acknowledgedAt: current.acknowledgedAt || now.toISOString(), fingerprint });
  }

  // Recorded the first time this machine's key creates or opens a repository.
  // Before that, a machine has nothing of its own to lose, which is what makes
  // adopting an entered key the right answer for a cold standby.
  noteFirstUse(now = new Date()) {
    if (this.readRecord().firstUsedAt) return this.readRecord();
    return this.writeRecord({ firstUsedAt: now.toISOString() });
  }

  // The owner replaced the key. Acknowledgement goes back to unsaved on
  // purpose: the kit in their drawer is now wrong, and the one gate MOS has
  // against backups only a lost machine can open belongs in front of them again
  // until they say they have the new one.
  rotate(fingerprint, now = new Date()) {
    return this.writeRecord({ acknowledgedAt: null, fingerprint, firstUsedAt: this.readRecord().firstUsedAt || now.toISOString(), rotatedAt: now.toISOString() });
  }

  // Taking over another server's backups on a machine that has never used its
  // own key: the entered key becomes this machine's, and the owner has plainly
  // just read it off their kit, so it counts as acknowledged.
  adopt(fingerprint, now = new Date()) {
    return this.writeRecord({ acknowledgedAt: now.toISOString(), adoptedAt: now.toISOString(), fingerprint, firstUsedAt: now.toISOString() });
  }

  escrow(key) {
    writeSecretFile(this.escrowPath, key, 0o750);
  }

  hasEscrow() {
    return fs.existsSync(this.escrowPath);
  }

  readEscrow() {
    return readSecretFile(this.escrowPath);
  }

  // Overwritten before it is unlinked. On a flash disk that is best effort —
  // the controller decides where the bytes land — and Ubuntu's weekly fstrim
  // discards the freed blocks; an owner who wants certainty rotates the key.
  discardEscrow() {
    try {
      const size = fs.statSync(this.escrowPath).size;
      const handle = fs.openSync(this.escrowPath, 'r+');
      try {
        fs.writeSync(handle, crypto.randomBytes(size), 0, size, 0);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch {}
    fs.rmSync(this.escrowPath, { force: true });
  }

  // `pending` while the escrow exists: the encryption protects nothing yet,
  // because a copy of the key sits on the plaintext partition.
  handover() {
    return this.hasEscrow() ? HANDOVER.PENDING : HANDOVER.DONE;
  }
}

module.exports = { ESCROW_PATH, HANDOVER, KEY_FILENAME, RECORD_FILENAME, RecoveryKeyStore, STATE_DIR };
