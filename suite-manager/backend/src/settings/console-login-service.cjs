const fs = require('node:fs');
const path = require('node:path');

// Written by the installer's first-boot script, on the machine that generated
// the password. Suite Manager only ever reads it and deletes it; it never
// creates one, because a password this process invented would not be the
// password the machine's console account actually has.
const HANDOVER_FILE = 'console-login.json';
// Replaces the handover file when the owner confirms they saved it. Two jobs:
// the installer's path unit watches for it and clears the console banner, and
// its presence is how this service tells "already handed over" apart from "this
// install never had a generated console login" — a cloud install, or one built
// with an explicit LINUX_PASSWORD.
const ACKNOWLEDGED_FILE = 'console-login.acknowledged';

class ConsoleLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ConsoleLoginError';
  }
}

class ConsoleLoginService {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
  }

  handoverPath() {
    return path.join(this.stateDir, HANDOVER_FILE);
  }

  acknowledgedPath() {
    return path.join(this.stateDir, ACKNOWLEDGED_FILE);
  }

  // Never includes the password. The dashboard asks for this on every load, so
  // a password in the answer would be a plaintext credential in a response the
  // owner never asked to see and a browser is free to cache.
  status() {
    const handover = this.#readHandover();
    if (handover) {
      return { acknowledged: false, pending: true, username: handover.username };
    }
    return { acknowledged: fs.existsSync(this.acknowledgedPath()), pending: false, username: '' };
  }

  // Deliberately a separate, explicit step: the password crosses the wire only
  // when the owner opens the panel to write it down.
  reveal() {
    const handover = this.#readHandover();
    if (!handover) {
      throw new ConsoleLoginError('CONSOLE_LOGIN_NOT_PENDING', 'This install has no server login waiting to be saved.');
    }
    return { password: handover.password, username: handover.username };
  }

  // The sentinel is written before the handover file is removed. Losing power
  // between the two leaves a machine whose banner clears and whose owner has
  // the password; the other order leaves a password on the console with nothing
  // left to clear it.
  acknowledge() {
    if (!this.#readHandover()) {
      // Already acknowledged is a success: the owner's intent is satisfied, and
      // a retry after a dropped response must not read as an error.
      return { acknowledged: true, pending: false };
    }
    fs.writeFileSync(this.acknowledgedPath(), `${JSON.stringify({ acknowledgedAt: new Date().toISOString(), version: 1 })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.rmSync(this.handoverPath(), { force: true });
    return { acknowledged: true, pending: false };
  }

  #readHandover() {
    let raw = '';
    try {
      raw = fs.readFileSync(this.handoverPath(), 'utf8');
    } catch {
      // No file is the normal steady state on every install past its handover,
      // and on every install that never generated a console login at all.
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.password !== 'string' || typeof parsed.username !== 'string') return null;
      if (!parsed.password || !parsed.username) return null;
      return { password: parsed.password, username: parsed.username };
    } catch {
      // A truncated file means first boot was interrupted mid-write. Reporting
      // nothing pending is right: there is no password here to hand over, and
      // the console banner is the owner's remaining path.
      return null;
    }
  }
}

module.exports = {
  ACKNOWLEDGED_FILE,
  ConsoleLoginError,
  ConsoleLoginService,
  HANDOVER_FILE,
};
