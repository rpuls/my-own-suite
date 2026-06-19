const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;

function emptyState() {
  return {
    owner: null,
    sessions: [],
    version: STATE_VERSION,
  };
}

class PlatformStateStore {
  constructor(stateDir) {
    if (!stateDir) {
      throw new Error('stateDir is required.');
    }

    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, 'platform-state.json');
  }

  load() {
    if (!fs.existsSync(this.statePath)) {
      return emptyState();
    }

    const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    return {
      ...emptyState(),
      ...parsed,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  }

  save(state) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const nextState = {
      ...state,
      version: STATE_VERSION,
    };
    fs.writeFileSync(this.statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    return nextState;
  }
}

module.exports = {
  PlatformStateStore,
};
