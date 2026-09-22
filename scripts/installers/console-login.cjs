'use strict';

// The machine's own server login: generated on the machine that will use it,
// on its own first boot, shown on the console and handed over once by Suite
// Manager. This renders the generator, the remover and their units for both
// seeds — the autoinstall ISO and the baked image — so the login has one
// definition and Suite Manager reads the same names from the shared contract.
//
// Deciding the password while the ISO is built cannot survive a published
// image: one build is flashed by every downloader, so the password would be
// shared by every install and extractable from the image. A fixed password
// takes the same path as a generated one rather than a shortcut around it, so
// the lab and smoke VMs exercise the real handover — console file, Suite
// Manager page, acknowledgement, cleanup — instead of a branch no published
// install ever runs.

const { shellQuote } = require('./bootstrap-contract.cjs');
const {
  CONSOLE_LOGIN_ACKNOWLEDGED_FILE,
  CONSOLE_LOGIN_HANDOVER_FILE,
  CONSOLE_LOGIN_ISSUE_PATH,
} = require('../../shared/console-login-contract.cjs');
const { INSTALLER_MEDIA_MARKER } = require('../../shared/vault-contract.cjs');

function renderConsoleLoginInitScript({ fixedPassword, runtimeUser, setupUrl, stateDir, username }) {
  const choosePassword = fixedPassword
    ? `# Fixed by the build profile, so this VM's login is predictable for humans
# and agents that have to reach it. Never used by a released image.
password=${shellQuote(fixedPassword)}`
    : `# No 0/1/l/o: this may have to be typed on a physical console, read off a screen.
raw="$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' < /dev/urandom 2>/dev/null | head -c 15 || true)"
if [ "\${#raw}" -ne 15 ]; then
  echo '[mos] Could not generate a console password from /dev/urandom.' >&2
  exit 1
fi
password="\${raw:0:5}-\${raw:5:5}-\${raw:10:5}"`;

  return `#!/usr/bin/env bash
set -euo pipefail

state_dir=${shellQuote(stateDir)}
handover="$state_dir/${CONSOLE_LOGIN_HANDOVER_FILE}"
acknowledged="$state_dir/${CONSOLE_LOGIN_ACKNOWLEDGED_FILE}"
username=${shellQuote(username)}
runtime_user=${shellQuote(runtimeUser)}

# A re-run must never rotate a password the owner may already have written down.
if [ -e "$handover" ] || [ -e "$acknowledged" ]; then
  exit 0
fi

${choosePassword}

printf '%s:%s\\n' "$username" "$password" | chpasswd
# The account ships locked. Unlocking it here is what makes the machine
# reachable at all, and only with the password chosen just above.
passwd -u "$username" >/dev/null 2>&1 || true

install -d -m 0755 "$state_dir"
umask 077
cat > "$handover.next" <<MOS_CONSOLE_LOGIN
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "password": "$password",
  "username": "$username",
  "version": 1
}
MOS_CONSOLE_LOGIN
chmod 0600 "$handover.next"
# This script runs as root, so root would own the file it leaves for a Suite
# Manager that runs as the unprivileged runtime user — which would then be shut
# out of the handover it is the only route for. Ownership is handed over before
# the file is in place, so it is never readable by nobody.
#
# On the ISO path the control-plane bootstrap runs after this and chowns the
# whole state root, which hid the problem. A machine installed from the prebuilt
# image ran that bootstrap at bake time and never chowns anything again.
chown "$runtime_user" "$handover.next"
mv "$handover.next" "$handover"

# Also on the physical console, because an owner who never opens Suite Manager
# from another machine would otherwise have no way to reach this one.
${renderConsoleIssueBlockWriter({ setupUrl })}
`;
}

// One writer replaces the console file and one remover deletes it, so nothing
// is ever appended to /etc/issue and a re-run cannot stack a second block.
//
// Four rows, and they are the last four of a twenty-five-row console: the
// address banner spends twenty and agetty spends the twenty-fifth on the prompt.
// This file used to be ten rows laid out for reading, which on an 80x25 machine
// pushed the top ten rows of that banner off the screen - the logo and the whole
// of the first address - so the one screen that cannot be corrected afterwards
// showed a password and no way to use it.
function renderConsoleIssueBlockWriter({ setupUrl }) {
  return `install -d -m 0755 /etc/issue.d
cat > ${CONSOLE_LOGIN_ISSUE_PATH} <<MOS_CONSOLE_ISSUE

  Server login (not your My Own Suite account):  $username / $password
  Save it, then confirm at ${setupUrl} to hide this.

MOS_CONSOLE_ISSUE
chmod 0644 ${CONSOLE_LOGIN_ISSUE_PATH}`;
}

// Removes the password from the physical console once Suite Manager reports the
// owner has saved it. Suite Manager runs unprivileged and cannot touch the
// console's files itself, so it drops a sentinel and this runs as root in
// response.
function renderConsoleLoginClearScript({ stateDir }) {
  return `#!/usr/bin/env bash
set -euo pipefail

state_dir=${shellQuote(stateDir)}

rm -f ${CONSOLE_LOGIN_ISSUE_PATH}
rm -f "$state_dir/${CONSOLE_LOGIN_HANDOVER_FILE}"

# One-shot by design: the handover happens once per install, so the watcher has
# no reason to survive it.
systemctl disable --now mos-console-login-clear.path >/dev/null 2>&1 || true
`;
}

// The generator waits for the vault, because its run-once record lives inside
// it: on a locked boot the directory it would look in is the empty one the
// vault mounts over, and a generator that ran there would set a password the
// owner has never seen. It never runs on the installer stick either, whose
// login would otherwise be shown and then lost the moment the disk is written.
function renderConsoleLoginUnits({ stateDir }) {
  return [
    {
      content: `[Unit]
Description=Generate this machine's own server login
Requires=mos-vault.service
After=mos-vault.service
Before=mos-first-boot.service
ConditionPathExists=!${INSTALLER_MEDIA_MARKER}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/mos-console-login-init

[Install]
WantedBy=multi-user.target
`,
      path: '/etc/systemd/system/mos-console-login.service',
      permissions: '0644',
    },
    {
      content: `[Unit]
Description=Clear the My Own Suite server login from the console banner
Requires=mos-vault.service
After=mos-vault.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mos-console-login-clear
`,
      path: '/etc/systemd/system/mos-console-login-clear.service',
      permissions: '0644',
    },
    {
      content: `[Unit]
Description=Watch for the owner confirming they saved the server login

[Path]
PathExists=${stateDir}/${CONSOLE_LOGIN_ACKNOWLEDGED_FILE}
Unit=mos-console-login-clear.service

[Install]
WantedBy=multi-user.target
`,
      path: '/etc/systemd/system/mos-console-login-clear.path',
      permissions: '0644',
    },
  ];
}

module.exports = { renderConsoleLoginClearScript, renderConsoleLoginInitScript, renderConsoleLoginUnits };
