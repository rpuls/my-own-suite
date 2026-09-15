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
// and how many copies it keeps.

const fs = require('node:fs');
const path = require('node:path');

const PRIMARY_FILENAME = 'primary-destination.json';

// Finds the primary among what is mounted right now. A drive that was unplugged
// and reconnected can come back on a different mount path, so the repository
// already on it identifies it when the path no longer does — an identity that
// belongs to the backups themselves rather than to where Linux happened to
// attach them this time.
function resolvePrimary(primary, mounted, repositoryId) {
  if (!primary?.destinationId) return null;
  const byPath = mounted.find((destination) => destination.id === primary.destinationId);
  if (byPath) return byPath;
  if (!primary.repositoryId) return null;
  const matches = mounted.filter((destination) => repositoryId(destination.id) === primary.repositoryId);
  return matches.length === 1 ? matches[0] : null;
}

class PrimaryDestination {
  constructor({ agentStateDir, now = () => new Date(), repositoryId = () => null }) {
    this.now = now;
    this.repositoryId = repositoryId;
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
      // Only knowable once a backup has written one, so a destination chosen
      // before its first backup carries none and is found by path until then.
      repositoryId: this.repositoryId(id) || (current?.destinationId === id ? current.repositoryId : null) || null,
      setAt: this.now().toISOString(),
    });
  }

  clear() {
    fs.rmSync(this.statePath, { force: true });
    return null;
  }

  resolve(mounted) {
    return resolvePrimary(this.read(), mounted, this.repositoryId);
  }

  // Captured after a backup rather than when the destination is chosen, because
  // an empty drive has no repository to be identified by yet.
  rememberRepository(destinationId) {
    const current = this.read();
    if (!current || current.destinationId !== destinationId || current.repositoryId) return current;
    const repositoryId = this.repositoryId(destinationId);
    return repositoryId ? this.write({ ...current, repositoryId }) : current;
  }

  // What the Backups screen shows. `label` is the name the destination had when
  // it was chosen, so a drive in a drawer is still named rather than reduced to
  // its mount path.
  state() {
    const current = this.read();
    return current ? { destinationId: current.destinationId, label: current.label, setAt: current.setAt || null } : null;
  }
}

module.exports = { PRIMARY_FILENAME, PrimaryDestination, resolvePrimary };
