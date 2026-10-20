// The one destination MOS writes to when it backs up without being asked.
//
// It belongs to the destinations, not to the schedule. The schedule was the
// first thing that backed up on its own, so it held the choice; now the
// checkpoint before an update backs up on its own too, and anything else that
// ever does would have had to either read the schedule's setting — which is not
// what that setting means — or add a second picker for the owner to keep in
// step with the first. One primary, chosen where destinations are listed,
// answers for all of them.
//
// The schedule keeps everything that is genuinely the schedule's: when it fires
// and how many copies it keeps. A destination is named by the storage it is —
// a drive's filesystem UUID or a bucket connection — so it is the same choice
// wherever Linux happens to attach the drive.

const fs = require('node:fs');
const path = require('node:path');

const PRIMARY_FILENAME = 'primary-destination.json';

class PrimaryDestination {
  constructor({ agentStateDir, now = () => new Date() }) {
    this.now = now;
    this.statePath = path.join(agentStateDir, PRIMARY_FILENAME);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const staged = `${this.statePath}.next`;
    fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(staged, this.statePath);
    return value;
  }

  save({ destinationId, label = null }) {
    const id = String(destinationId || '').trim();
    if (!id) throw new Error('Choose the destination automatic backups should be written to.');
    const current = this.read();
    return this.write({
      destinationId: id,
      label: String(label || '').trim() || (current?.destinationId === id ? current.label : null),
      setAt: this.now().toISOString(),
    });
  }

  clear() {
    fs.rmSync(this.statePath, { force: true });
    return null;
  }

  // The primary among the destinations listed right now, or null.
  resolve(destinations) {
    const chosen = this.read();
    return chosen ? destinations.find((destination) => destination.id === chosen.destinationId) || null : null;
  }

  // What the Backups screen shows. `label` is the name the destination had when
  // it was chosen, so a drive in a drawer is still named.
  state() {
    const current = this.read();
    return current ? { destinationId: current.destinationId, label: current.label, setAt: current.setAt || null } : null;
  }
}

module.exports = { PrimaryDestination };
