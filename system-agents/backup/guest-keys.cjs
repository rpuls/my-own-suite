// The recovery keys of archives this server does not own.
//
// Connecting to backups another server wrote must not change them in any way:
// not their contents, not their key list, not one byte of metadata. So the key
// the owner enters is kept here, against the destination it opens, and handed
// to the engine for every command aimed at that destination. The archive stays
// exactly as its own server left it, and this server never becomes a second
// holder of a password to someone else's data.
//
// Like the machine's own key this lives in the agent state directory: root
// only, machine local, and never backed up. Losing it costs nothing but typing
// the key again.

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint: recoveryKeyFingerprint } = require('./recovery-key.cjs');

const RECORD_FILENAME = 'guest-keys.json';
const RECORD_VERSION = 1;

class GuestKeyStore {
  constructor({ agentStateDir, recordPath } = {}) {
    this.recordPath = recordPath || path.join(agentStateDir || '.', RECORD_FILENAME);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
      return parsed && typeof parsed.destinations === 'object' && parsed.destinations ? parsed.destinations : {};
    } catch {
      return {};
    }
  }

  write(destinations) {
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    fs.writeFileSync(this.recordPath, `${JSON.stringify({ destinations, version: RECORD_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.recordPath, 0o600);
    return destinations;
  }

  keyFor(destinationId) {
    return this.read()[destinationId]?.key || null;
  }

  save(destinationId, key, now = new Date()) {
    const destinations = this.read();
    destinations[destinationId] = { fingerprint: recoveryKeyFingerprint(key), key, savedAt: now.toISOString() };
    this.write(destinations);
    return destinations[destinationId];
  }

  forget(destinationId) {
    const destinations = this.read();
    if (!(destinationId in destinations)) return false;
    delete destinations[destinationId];
    this.write(destinations);
    return true;
  }

  // Which destinations are opened with a borrowed key, without the keys
  // themselves: what the screen needs to say per place which key opens it.
  summaries() {
    const destinations = this.read();
    return Object.keys(destinations).map((destinationId) => ({
      destinationId,
      fingerprint: destinations[destinationId].fingerprint || null,
      savedAt: destinations[destinationId].savedAt || null,
    }));
  }
}

module.exports = { GuestKeyStore };
