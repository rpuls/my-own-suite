const fs = require('node:fs');
const path = require('node:path');

const {
  CONSOLE_LOGIN_ACKNOWLEDGED_FILE,
  CONSOLE_LOGIN_HANDOVER_FILE,
} = require('../../../../shared/console-login-contract.cjs');

// The server login this machine generated for itself, as Suite Manager hands it
// over. The installer's first-boot generator writes the handover file, on the
// machine that generated the password; Suite Manager only ever reads it and
// deletes it, because a password this process invented would not be the
// password the console account actually has. The acknowledged file replaces it
// when the owner confirms: the installer's path unit watches for it and clears
// the console, and its presence tells "already handed over" apart from "this
// install never had a generated login".

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
    return path.join(this.stateDir, CONSOLE_LOGIN_HANDOVER_FILE);
  }

  acknowledgedPath() {
    return path.join(this.stateDir, CONSOLE_LOGIN_ACKNOWLEDGED_FILE);
  }

  // Whether a login is waiting, read with every setup status. Never the
  // password: that travels only in the answer to an explicit reveal. A handover
  // this process cannot open is reported as such rather than as none, because
  // the two need opposite responses — one is the steady state of every install
  // past its handover, the other is a password stranded on disk with no way to
  // reach its owner.
  status() {
    if (this.#readHandover()) return { pending: true, unreadable: false };
    return { pending: false, unreadable: this.#handoverUnreadable() };
  }

  // Deliberately a separate, explicit step: the password crosses the wire only
  // when the owner opens the page to write it down.
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

  // True when a handover exists but this process cannot read it — an ownership
  // or permission fault on the installer's side.
  #handoverUnreadable() {
    try {
      fs.accessSync(this.handoverPath(), fs.constants.R_OK);
      return false;
    } catch (error) {
      return error.code !== 'ENOENT';
    }
  }

  #readHandover() {
    let raw = '';
    try {
      raw = fs.readFileSync(this.handoverPath(), 'utf8');
    } catch (error) {
      // No file is the normal steady state on every install past its handover,
      // and on every install that never generated a console login at all.
      // Anything else is a fault, and silence about it is what turned a one-line
      // ownership bug into a handover that appeared never to have existed.
      if (error.code !== 'ENOENT') {
        console.error(`[mos-suite-manager] Console login handover is unreadable (${error.code}): ${this.handoverPath()}`);
      }
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

module.exports = { ConsoleLoginError, ConsoleLoginService };
