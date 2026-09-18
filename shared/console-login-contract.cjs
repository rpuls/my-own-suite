'use strict';

// The machine's own server login, as a contract between the three things that
// touch it: the installer's generator writes it, Suite Manager reads it and
// hands it over, and the console shows it until the owner confirms. Each of
// those runs from a different place, so the names live here and nowhere else.

// Written by the first-boot generator into Suite Manager's state directory,
// which is inside the vault on a machine that has one. Read by Suite Manager,
// deleted when the owner confirms they have saved the password.
const CONSOLE_LOGIN_HANDOVER_FILE = 'console-login.json';
// Left behind by Suite Manager when the owner confirms. The installer's path
// unit fires on it and clears the console, and its presence is how "already
// handed over" is told apart from "this install never generated a login".
const CONSOLE_LOGIN_ACKNOWLEDGED_FILE = 'console-login.acknowledged';
// The login block on the physical console, as its own file after the address
// banner so agetty prints the banner, then this, then the login prompt. One
// writer replaces it and one remover deletes it; nothing is appended to
// /etc/issue.
const CONSOLE_LOGIN_ISSUE_PATH = '/etc/issue.d/20-mos-server-login.issue';

module.exports = {
  CONSOLE_LOGIN_ACKNOWLEDGED_FILE,
  CONSOLE_LOGIN_HANDOVER_FILE,
  CONSOLE_LOGIN_ISSUE_PATH,
};
