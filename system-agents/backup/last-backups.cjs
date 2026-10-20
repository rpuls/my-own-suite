'use strict';

// When each destination last received one of this server's backups.
//
// A drive that is not plugged in is the one copy anything that gets root on
// this server cannot erase, so MOS has to be able to say when it was last
// brought up to date while it sits in a drawer — and the backups on it cannot
// be read then. Which drives MOS remembers is the storage module's; this is
// only the date, kept by the destination's id.

const fs = require('node:fs');
const path = require('node:path');

const RECORD_FILENAME = 'last-backups.json';

class LastBackups {
  constructor({ agentStateDir, recordPath } = {}) {
    this.recordPath = recordPath || path.join(agentStateDir || '.', RECORD_FILENAME);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  of(destinationId) {
    return this.read()[destinationId] || null;
  }

  // Written only when the date moves on: the status this is read for is polled.
  note(destinationId, createdAt) {
    const record = this.read();
    if (!createdAt || record[destinationId] === createdAt) return;
    record[destinationId] = createdAt;
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    fs.writeFileSync(this.recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

module.exports = { LastBackups, RECORD_FILENAME };
