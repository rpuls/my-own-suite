const fs = require('node:fs');
const path = require('node:path');

const { APP_STATUS_ROOT } = require('../../infrastructure/control-plane-runtime.cjs');

// The page an app's own address answers with while MOS has paused it because its
// drive is out. Caddy serves it only when the app does not answer, so it can never
// hide a running app. It refreshes itself, so the app appears the moment it is back.

const SITE_LINE = /^(https?):\/\/([^\s{]+)\s*\{/u;

// Every address an app answers on, read from its own block in the routes file.
function appHosts(routesText) {
  const hosts = new Map();
  let current = null;
  for (const line of String(routesText || '').split('\n')) {
    const start = line.match(/^# mos-app-route:start (\S+)/u);
    if (start) { current = start[1]; hosts.set(current, []); continue; }
    if (/^# mos-app-route:end /u.test(line)) { current = null; continue; }
    const site = current && line.match(SITE_LINE);
    if (site) hosts.get(current).push(site[2]);
  }
  return hosts;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function pausedSentence({ appName, driveName, state }) {
  if (state === 'ejected') return `Its ${driveName} was ejected. Plug the drive back in, or open Suite Manager to use it again without replugging.`;
  if (state === 'away') return `Its ${driveName} is not connected. Plug the drive back in and ${appName} returns on its own.`;
  return `Its ${driveName} could not be opened. Open Suite Manager to see why.`;
}

function pausedPage({ appName, driveName, host, state }) {
  const suiteManager = `//home.${host.split('.').slice(1).join('.')}/suite-manager/settings#set-storage`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${escapeHtml(appName)} is paused</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: #061526; color: #eef4ff; font: 16px/1.6 'Segoe UI', system-ui, sans-serif; }
main { max-width: 460px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; }
p { margin: 0 0 20px; color: #b8c9de; }
a { display: inline-block; padding: 10px 18px; border-radius: 12px; background: #63e2b3; color: #062016; font-weight: 700; text-decoration: none; }
small { display: block; margin-top: 20px; color: #8fa3bd; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(appName)} is paused</h1>
<p>${escapeHtml(pausedSentence({ appName, driveName, state }))}</p>
<a href="${escapeHtml(suiteManager)}">Open Suite Manager</a>
<small>This page checks again every 15 seconds.</small>
</main>
</body>
</html>
`;
}

class PausedPages {
  constructor({ appNameOf, root = APP_STATUS_ROOT, routesPath }) {
    this.appNameOf = appNameOf;
    this.root = root;
    this.routesPath = routesPath;
  }

  // `paused` maps a package to the drive that paused it; every other page goes.
  sync(paused) {
    let routes = '';
    try { routes = fs.readFileSync(this.routesPath, 'utf8'); } catch {}
    const hosts = appHosts(routes);
    const wanted = new Map();
    for (const [packageId, drive] of paused) {
      const appName = this.appNameOf(packageId) || packageId;
      for (const host of hosts.get(packageId) || []) wanted.set(`${host}.html`, pausedPage({ appName, driveName: drive.driveName, host, state: drive.state }));
    }
    // Caddy reads these as its own user; the agent's umask would keep it out.
    fs.mkdirSync(this.root, { recursive: true });
    fs.chmodSync(this.root, 0o755);
    for (const name of fs.readdirSync(this.root)) {
      if (name.endsWith('.html') && !wanted.has(name)) fs.rmSync(path.join(this.root, name), { force: true });
    }
    for (const [name, html] of wanted) {
      const file = path.join(this.root, name);
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch {}
      if (current !== html) {
        fs.writeFileSync(file, html);
        fs.chmodSync(file, 0o644);
      }
    }
  }
}

// Apps a drive is keeping out: its folders are there only while it is open.
function pausedByDrives(drives) {
  const paused = new Map();
  for (const drive of drives) {
    if (!['away', 'ejected', 'failed'].includes(drive.state)) continue;
    for (const app of drive.apps || []) paused.set(app, { driveName: drive.name || drive.label, state: drive.state });
  }
  return paused;
}

module.exports = { PausedPages, appHosts, pausedByDrives, pausedPage };
