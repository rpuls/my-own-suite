'use strict';

// The page a locked machine serves.
//
// It is the only screen MOS can show before the vault opens: the Suite Manager
// store, every app and every secret are inside it, so nothing else is running.
// That makes this page the whole product for as long as it is up, and it is why
// it is plain HTML with a plain form and no JavaScript requirement — an owner
// standing in front of a machine that will not come back needs the field to
// work, not to work once a bundle has loaded.
//
// Caddy already routes here: `handle_errors` in the generated Caddyfile answers
// with this agent whenever Suite Manager is not listening, which on a locked
// machine is always. Colours are the MOS brand tokens by value for the same
// reason the busy page states them that way — there is no build step here and
// no stylesheet to import.

const { RECOVERY_KEY_PREFIX } = require('../backup/recovery-key.cjs');
const { VAULT_UNLOCK_ROUTE } = require('../../infrastructure/control-plane-runtime.cjs');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    background: #f4f8fd;
    color: #0d2135;
    display: flex;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    min-height: 100vh;
    padding: 24px 16px;
  }
  main { margin: auto; max-width: 30rem; width: 100%; }
  h1 { font-size: 1.5rem; letter-spacing: -0.03em; line-height: 1.3; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; }
  .meta { color: #4a6076; font-size: 0.9rem; }
  form { margin: 1.25rem 0 0.75rem; }
  label { display: block; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.08em; margin-bottom: 0.5rem; text-transform: uppercase; }
  input {
    background: #ffffff;
    border: 1px solid rgba(9, 30, 54, 0.18);
    border-radius: 10px;
    box-sizing: border-box;
    color: inherit;
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.04em;
    padding: 0.7rem 0.8rem;
    width: 100%;
  }
  input:focus-visible { border-color: #1c9e6d; outline: 3px solid rgba(40, 188, 132, 0.24); outline-offset: 1px; }
  button {
    background: #1c9e6d;
    border: 0;
    border-radius: 999px;
    color: #ffffff;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    margin-top: 0.75rem;
    padding: 0.6rem 1.4rem;
  }
  .notice {
    border-left: 3px solid #c0392b;
    margin: 0 0 0.75rem;
    padding: 0.1rem 0 0.1rem 0.7rem;
  }
  .working { border-left-color: #1c9e6d; }
  details { margin: 1.5rem 0 0; }
  summary { cursor: pointer; font-size: 0.9rem; }
  details form { margin-top: 0.5rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #091e36; color: #eaf2fb; }
    .meta { color: #b8c9de; }
    input { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.18); }
    button { background: #63e2b3; color: #05233c; }
  }
`;

// The recovery-key form, which is both the whole page on a machine that opens
// itself and the way back on one that asks for a password.
function keyForm({ autofocus }) {
  return `<form method="post" action="${escapeHtml(VAULT_UNLOCK_ROUTE)}">
<label for="recovery-key">Recovery key</label>
<input autocapitalize="characters" autocomplete="off"${autofocus ? ' autofocus' : ''} id="recovery-key" name="recoveryKey"
  placeholder="${escapeHtml(RECOVERY_KEY_PREFIX)}-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" spellcheck="false" type="text">
<button type="submit">Unlock</button>
</form>`;
}

/**
 * @param {object} options
 * @param {boolean} options.askPassword this machine waits for the owner's password
 * @param {string|null} options.sentence why the machine could not open itself
 * @param {string|null} options.error what was wrong with what was just entered
 * @param {boolean} options.unlocked it worked and the suite is starting
 * @param {boolean} options.resealed the chip was taught this machine's new state
 * @param {boolean} options.repairPending the chip is taught again at the next sign-in
 */
function renderLockedPage({
  askPassword = false,
  error = null,
  repairPending = false,
  resealed = false,
  sentence = null,
  unlocked = false,
} = {}) {
  if (unlocked) {
    // The refresh lands on `/` rather than back here: this route is always the
    // agent's, so a page that reloaded itself would never reach Suite Manager.
    // The re-seal line is said only when it happened; silence covers a machine
    // with no chip, which was told at setup that it asks every time.
    const reseal = resealed
      ? '<p>This server has taught its security chip the way it now starts, so the next restart behaves as it did before.</p>'
      : repairPending
        ? '<p>The next time you sign in to Suite Manager, this server teaches its security chip your password again. Until then a restart asks for this key rather than your password.</p>'
        : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10; url=/">
<title>My Own Suite is unlocking</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Unlocked</h1>
<p class="notice working">Your data is open and your apps are starting.</p>
<p>This takes a minute or two. The page moves on by itself when Suite Manager answers.</p>
${reseal}
<p class="meta">Nothing else needs doing.</p>
</main>
</body>
</html>
`;
  }

  const notices = `${sentence ? `<p class="notice">${escapeHtml(sentence)}</p>` : ''}
${error ? `<p class="notice">${escapeHtml(error)}</p>` : ''}`;

  // Two forms rather than one with two fields: each has one thing to type and
  // one button, on a page that has to work for someone standing in front of a
  // server that will not come back. The recovery key sits inside a `details`
  // because it is the exception, and `details` needs no JavaScript.
  if (askPassword) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Own Suite needs your password</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Your server restarted</h1>
<p>Your data is encrypted, and this server is set to ask for your password before it opens. Enter the password you sign in to Suite Manager with.</p>
${notices}
<form method="post" action="${escapeHtml(VAULT_UNLOCK_ROUTE)}">
<label for="owner-password">Your Suite Manager password</label>
<input autocapitalize="off" autocomplete="current-password" autofocus id="owner-password" name="password" spellcheck="false" type="password">
<button type="submit">Unlock</button>
</form>
<p class="meta">Nothing has been lost. Your apps are stopped, not gone, and they start as soon as this is open.</p>
<details>
<summary>Use your recovery key instead</summary>
<p class="meta">For a forgotten password, or a chip that has stopped answering. It is on the recovery kit you saved when you set this server up. Capitals, spaces and dashes do not matter.</p>
${keyForm({ autofocus: false })}
</details>
</main>
</body>
</html>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Own Suite is locked</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Your data is locked</h1>
<p>This server is running, but everything of yours on it is encrypted and needs your recovery key to open.</p>
${notices}
${keyForm({ autofocus: true })}
<p class="meta">Your recovery key is on the recovery kit you saved when you set this server up. It is the same key that opens your backups. Capitals, spaces and dashes do not matter.</p>
<p class="meta">Nothing has been lost. Your apps are stopped, not gone, and they start as soon as the vault opens.</p>
</main>
</body>
</html>
`;
}

module.exports = { escapeHtml, renderLockedPage };
