const fs = require('node:fs');
const path = require('node:path');

const {
  EASY_DOOR_ACME_SERVER,
  EASY_DOOR_CADDY_MARKER,
  EASY_DOOR_HOME_HOST_REGEXP,
  EASY_DOOR_ZONE,
  easyDoorAddressOf,
  easyDoorBaseDomain,
} = require('../shared/easy-door.cjs');

const HOMEPAGE_IMAGE = 'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a';
const HOMEPAGE_PORT = 3200;

// The installs that front Suite Manager with their own public name and never
// have an Easy Door.
const PUBLIC_CLOUD_FRONT_DOORS = Object.freeze(['cloud-init', 'digitalocean-smoke', 'public-vps']);

// The two ways a suite is hosted. A public server is reachable from the internet,
// so a domain proves itself the way any website's does; a home server is not,
// so its domain proves itself through Cloudflare DNS, and it has the Easy Door.
function hostingTrack(frontDoor) {
  return PUBLIC_CLOUD_FRONT_DOORS.includes(frontDoor) ? 'public-server' : 'home-server';
}
// Install and every managed update refuse a Caddy binary without both: an owned
// domain proves itself through Cloudflare, the Easy Door through the ACME responder.
const CADDY_REQUIRED_MODULES = Object.freeze(['dns.providers.cloudflare', 'dns.providers.acmedns']);
// Scaffolding for one binary, removed once it is copied out: left behind, the
// builder base alone keeps about 400 MB on every machine.
const CADDY_BUILD_IMAGES = Object.freeze(['mos-caddy-builder', caddyBuilderBaseImage()]);

function caddyBuilderBaseImage() {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'caddy', 'Dockerfile'), 'utf8');
  return dockerfile.match(/^FROM (\S+) AS builder\b/mu)[1];
}

const UNAVAILABLE_PAGE_ROOT = '/etc/caddy/mos-status';
const UNAVAILABLE_PAGE_FILENAME = 'unavailable.html';
// Written by the backup agent while a job runs, removed when it ends, and
// polled by the status page below. The agent decides the words; both surfaces
// only render what it wrote.
const PROGRESS_FILENAME = 'progress.json';
const PROGRESS_ROUTE = `/mos-status/${PROGRESS_FILENAME}`;
const PROGRESS_STALE_MINUTES = 30;
// The vault agent, which is the only thing listening on a machine whose disk
// has not been unlocked yet. Suite Manager, every app and every secret are
// inside the vault, so the page that asks for the recovery key cannot come from
// any of them and its form cannot post to any of them.
const VAULT_AGENT_PORT = 3300;
const VAULT_UNLOCK_ROUTE = '/mos-unlock';

// The one path Caddy answers itself while Suite Manager is down: the progress
// file the status page polls. It is its own route, matched before anything is
// proxied, because the error handler below rewrites every request that errors
// to the HTML page — a fetch that fell through to the proxy would get the page
// back as its JSON. An absent file answers 204 rather than 404 for the same
// reason: a 404 from `file_server` is an error Caddy raises itself, and the
// handler would turn it into the page too. `handle` is ordered before
// `reverse_proxy` whatever order the lines are in, and among sibling `handle`
// blocks the one with the longer path matcher goes first; it is written first
// anyway so the file reads the way Caddy evaluates it.
function progressRoute(indent = '  ') {
  return [
    `handle ${PROGRESS_ROUTE} {`,
    `  root * ${UNAVAILABLE_PAGE_ROOT}`,
    `  @present file /${PROGRESS_FILENAME}`,
    '  handle @present {',
    '    header Cache-Control no-store',
    `    rewrite * /${PROGRESS_FILENAME}`,
    '    file_server',
    '  }',
    '  handle {',
    '    respond 204',
    '  }',
    '}',
  ].map((line) => `${indent}${line}`).join('\n');
}

// The form on the locked page posts here. It is a route of its own, ordered
// before the proxy for the same reason the progress file is: everything that
// errors is rewritten to the status page, so a POST that fell through to a
// stopped Suite Manager would come back as HTML and the owner's key would go
// nowhere. The agent answers with a page either way, which is what lets the
// whole exchange work in a browser with no JavaScript.
function unlockRoute(indent = '  ') {
  return [
    `handle ${VAULT_UNLOCK_ROUTE} {`,
    `  reverse_proxy 127.0.0.1:${VAULT_AGENT_PORT}`,
    '}',
  ].map((line) => `${indent}${line}`).join('\n');
}

// The routes Caddy answers while the control plane is down, in the order it
// evaluates them. Rendered as one unit so a future third route is added here
// rather than in each of the six site blocks below.
function statusRoutes(indent = '  ') {
  return [progressRoute(indent), unlockRoute(indent)].join('\n');
}

// Suite Manager is deliberately stopped for the whole middle of a restore, so
// the owner refreshing the page met Caddy's bare `502 Bad Gateway` at the exact
// moment they were most worried about their data — a drill finding, and the one
// screen in recovery that said nothing at all.
//
// `handle_errors` catches only errors Caddy raises itself, which in a block that
// nothing but reverse-proxies means an upstream it could not reach. A real 404
// or 500 from Suite Manager is a response, not an error, and still reaches the
// browser unchanged.
function unavailableHandler(indent = '  ') {
  return [
    'handle_errors {',
    `  root * ${UNAVAILABLE_PAGE_ROOT}`,
    `  rewrite * /${UNAVAILABLE_PAGE_FILENAME}`,
    '  header Retry-After 15',
    '  file_server {',
    '    status 503',
    '  }',
    '}',
  ].map((line) => `${indent}${line}`).join('\n');
}

// Served by Caddy with nothing else running, so it carries no font, no image
// and no script from anywhere else — a page that reached for any of those
// would be a second broken request during the outage it exists to explain. It
// refreshes itself because the owner's next move is otherwise to keep pressing
// reload on a dead tab.
//
// The wording covers every reason the control plane can be down, because Caddy
// cannot tell them apart. Naming a restore alone would be a guess, and a wrong
// one is worse here than a general answer. What it can add is what the backup
// agent wrote: the inline script polls the progress file and fills the section
// below, and with no file, no JSON, or no JavaScript the page is exactly the
// static one above it. Progress is layered on a page that already works; it is
// never what the page depends on.
//
// Colours are the MOS brand tokens by value, because the page has no build
// step and no stylesheet to import: light-theme text and background from
// `[data-theme='light']` and the default dark ones from `:root` in
// branding/styles/mos.css.
function renderUnavailablePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>My Own Suite is busy</title>
<style>
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
  h2 { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.08em; margin: 0 0 0.5rem; text-transform: uppercase; }
  p { margin: 0 0 0.75rem; }
  .meta { color: #4a6076; font-size: 0.9rem; }
  #mos-progress {
    border-top: 1px solid rgba(9, 30, 54, 0.09);
    border-bottom: 1px solid rgba(9, 30, 54, 0.09);
    margin: 1.25rem 0;
    padding: 1rem 0 0.5rem;
  }
  #mos-progress h2 { color: #1c9e6d; }
  #mos-progress-now { font-weight: 600; }
  #mos-progress-count { margin-bottom: 0.35rem; }
  #mos-progress-bar {
    background: rgba(9, 30, 54, 0.14);
    border-radius: 999px;
    height: 0.5rem;
    margin: 0 0 0.75rem;
    overflow: hidden;
  }
  #mos-progress-fill { background: #1c9e6d; border-radius: 999px; display: block; height: 100%; width: 0; }
  #mos-progress-plan, #mos-progress-plan ul { list-style: none; margin: 0 0 0.75rem; padding: 0; }
  #mos-progress-plan li { padding: 0.15rem 0 0.15rem 1.4rem; position: relative; }
  #mos-progress-plan li::before {
    background: rgba(9, 30, 54, 0.14);
    border-radius: 999px;
    content: "";
    height: 0.5rem;
    left: 0.25rem;
    position: absolute;
    top: 0.65rem;
    width: 0.5rem;
  }
  #mos-progress-plan li.is-done { color: #4a6076; }
  #mos-progress-plan li.is-done::before { background: #1c9e6d; }
  #mos-progress-plan li.is-now { font-weight: 600; }
  #mos-progress-plan li.is-now::before { background: #1c9e6d; box-shadow: 0 0 0 3px rgba(40, 188, 132, 0.24); }
  #mos-progress-plan li.is-next { color: #4a6076; }
  /* The group's own parts: one indent in, smaller, and only worth reading
     while that group is the one running — which is when it opens itself. */
  #mos-progress-plan summary { cursor: pointer; list-style: none; }
  #mos-progress-plan summary::-webkit-details-marker { display: none; }
  #mos-progress-plan summary::after {
    border-bottom: 2px solid currentColor;
    border-right: 2px solid currentColor;
    content: "";
    display: inline-block;
    height: 0.32rem;
    margin: 0 0 0.12rem 0.45rem;
    opacity: 0.5;
    transform: rotate(45deg);
    width: 0.32rem;
  }
  #mos-progress-plan details[open] summary::after { margin-bottom: -0.05rem; transform: rotate(-135deg); }
  #mos-progress-plan ul { font-size: 0.9rem; margin: 0.1rem 0 0.3rem; }
  #mos-progress-plan ul li { font-weight: 400; padding-left: 1.1rem; }
  #mos-progress-plan ul li::before { height: 0.35rem; left: 0.33rem; top: 0.6rem; width: 0.35rem; }
  #mos-progress-plan ul li.is-now { font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #061526; color: #eef4ff; }
    .meta { color: #b8c9de; }
    #mos-progress { border-color: rgba(255, 255, 255, 0.08); }
    #mos-progress h2 { color: #63e2b3; }
    #mos-progress-bar { background: rgba(255, 255, 255, 0.18); }
    #mos-progress-fill { background: #63e2b3; }
    #mos-progress-plan li::before { background: rgba(255, 255, 255, 0.18); }
    #mos-progress-plan li.is-done::before, #mos-progress-plan li.is-now::before { background: #63e2b3; }
    #mos-progress-plan li.is-now::before { box-shadow: 0 0 0 3px rgba(99, 226, 179, 0.18); }
    #mos-progress-plan li.is-done, #mos-progress-plan li.is-next { color: #b8c9de; }
  }
</style>
</head>
<body>
<main>
<h1>My Own Suite is busy right now</h1>
<p>The server is running, but Suite Manager is not answering yet.</p>
<p>If you started a restore or an update, this is expected — it is stopped on purpose while that finishes, and comes back on its own.</p>
<section id="mos-progress" hidden aria-live="polite">
<h2 id="mos-progress-headline"></h2>
<p id="mos-progress-now"></p>
<p id="mos-progress-count" hidden></p>
<div id="mos-progress-bar" hidden><span id="mos-progress-fill"></span></div>
<p class="meta" id="mos-progress-note" hidden></p>
<ol id="mos-progress-plan" hidden></ol>
<p class="meta" id="mos-progress-expect" hidden></p>
</section>
<p class="meta">This page checks again every 15 seconds. Nothing is lost while it waits.</p>
</main>
<script>
${renderUnavailablePageScript()}
</script>
</body>
</html>
`;
}

// The enhancement, and nothing but the enhancement. Every read is guarded and
// every failure hides the section again, because this page is what the owner
// sees when things are already going wrong, and a blank screen because a fetch
// threw would be a failure at the worst possible moment.
//
// A file the agent stopped updating is not shown: a worker that lost power
// mid-restore never cleared it, and the page must not tell the next owner who
// loads it that a restore is running. The agent removes the file when a job
// ends and when it finds one its worker abandoned; this is the last line.
function renderUnavailablePageScript() {
  return `(function () {
  var root = document.getElementById('mos-progress');
  if (!root || typeof fetch !== 'function') return;
  var STALE_MS = ${PROGRESS_STALE_MINUTES} * 60 * 1000;
  function el(id) { return document.getElementById(id); }
  function setText(id, value) { var node = el(id); if (node) { node.textContent = value || ''; node.hidden = !value; } }
  function hide() { root.hidden = true; }
  function agoWords(ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'Started under a minute ago.';
    return 'Started ' + (minutes === 1 ? 'a minute' : minutes + ' minutes') + ' ago.';
  }
  function stateWord(value) { return value === 'done' || value === 'now' ? value : 'next'; }
  function lines(entry) { return Array.isArray(entry.steps) ? entry.steps.filter(function (line) { return line && typeof line.sentence === 'string'; }) : []; }
  // The groups are built once and then only repainted, because the owner may
  // have opened a finished group to read it and a rebuild every few seconds
  // would close it under them.
  var groups = [];
  var built = '';
  function buildPlan(list, plan) {
    while (list.firstChild) list.removeChild(list.firstChild);
    groups = [];
    for (var i = 0; i < plan.length; i += 1) {
      var entry = plan[i];
      var item = document.createElement('li');
      var steps = lines(entry);
      var detail = null;
      var rows = [];
      if (steps.length) {
        detail = document.createElement('details');
        var summary = document.createElement('summary');
        summary.textContent = entry.sentence;
        detail.appendChild(summary);
        var sub = document.createElement('ul');
        for (var j = 0; j < steps.length; j += 1) {
          var row = document.createElement('li');
          row.textContent = steps[j].sentence;
          sub.appendChild(row);
          rows.push(row);
        }
        detail.appendChild(sub);
        item.appendChild(detail);
      } else {
        item.textContent = entry.sentence;
      }
      list.appendChild(item);
      groups.push({ detail: detail, item: item, rows: rows, state: '' });
    }
  }
  function paintPlan(list, plan) {
    var usable = [];
    for (var i = 0; i < plan.length; i += 1) {
      if (plan[i] && typeof plan[i].sentence === 'string') usable.push(plan[i]);
    }
    var shape = [];
    for (i = 0; i < usable.length; i += 1) shape.push(usable[i].sentence + '/' + lines(usable[i]).length);
    var key = shape.join('|');
    if (key !== built) { buildPlan(list, usable); built = key; }
    for (i = 0; i < usable.length; i += 1) {
      var group = groups[i];
      var state = stateWord(usable[i].state);
      group.item.className = 'is-' + state;
      // The running group opens itself and folds away when it is done — but
      // only as it changes, so a group the owner opened stays open.
      if (group.detail && state !== group.state) group.detail.open = state === 'now';
      group.state = state;
      var steps = lines(usable[i]);
      for (var j = 0; j < group.rows.length; j += 1) group.rows[j].className = 'is-' + stateWord(steps[j] && steps[j].state);
    }
    list.hidden = !list.firstChild;
  }
  function render(data, now) {
    if (!data || typeof data !== 'object' || typeof data.headline !== 'string' || typeof data.sentence !== 'string' || !Array.isArray(data.plan)) { hide(); return false; }
    var updated = Date.parse(data.updatedAt);
    if (!isFinite(updated) || now - updated > STALE_MS || updated - now > STALE_MS) { hide(); return false; }
    setText('mos-progress-headline', data.headline);
    var steps = Number(data.step) > 0 && Number(data.steps) > 1 ? ' — step ' + data.step + ' of ' + data.steps : '';
    setText('mos-progress-now', data.sentence + steps);
    var count = data.count && typeof data.count === 'object' ? data.count : null;
    setText('mos-progress-count', count && typeof count.sentence === 'string' ? count.sentence : '');
    setText('mos-progress-note', count && typeof count.note === 'string' ? count.note : '');
    var bar = el('mos-progress-bar');
    var fill = el('mos-progress-fill');
    var share = count && Number(count.total) > 0 ? Math.max(0, Math.min(1, Number(count.done) / Number(count.total))) : null;
    if (bar) bar.hidden = share === null;
    if (fill) fill.style.width = (share === null ? 0 : Math.round(share * 100)) + '%';
    var list = el('mos-progress-plan');
    if (list) paintPlan(list, data.plan);
    var started = Date.parse(data.startedAt);
    var timing = [];
    if (data.expect && typeof data.expect.sentence === 'string') timing.push(data.expect.sentence);
    if (isFinite(started) && now - started >= 0 && now - started < 24 * 60 * 60 * 1000) timing.push(agoWords(now - started));
    setText('mos-progress-expect', timing.join(' '));
    root.hidden = false;
    return true;
  }
  function poll() {
    var request;
    try { request = fetch('${PROGRESS_ROUTE}', { cache: 'no-store' }); } catch (error) { hide(); return; }
    request.then(function (response) {
      if (!response || !response.ok || response.status === 204) { hide(); return null; }
      var type = (response.headers && response.headers.get('content-type')) || '';
      if (type.indexOf('json') === -1) { hide(); return null; }
      return response.json();
    }).then(function (data) { if (data) render(data, Date.now()); else hide(); }).catch(hide);
  }
  poll();
  setInterval(poll, 5000);
})();`;
}

// The second site block is the Easy Door: Suite Manager on the name the MOS
// nameserver answers for this machine's LAN address, so a browser reaches a
// fresh install with nothing configured. It matches by pattern instead of naming
// one host because this file is written once — by the installer, and baked into
// the published disk image — and cannot know the address the machine will get.
// The fallback keeps the 404 an unmatched site address already returned, so a
// request to the bare address still says nothing about what runs here.
//
// Nothing closes this door, ever: a door is not an address. Applying a real
// domain changes where apps and Homepage are published, and the HTTPS Caddyfile
// keeps this block so Suite Manager itself still answers on the name the owner
// may be standing on when the change lands.
function easyDoorSiteBlock(suiteManagerPort = '$MOS_SUITE_MANAGER_PORT') {
  return `${EASY_DOOR_CADDY_MARKER}
http:// {
${statusRoutes()}
  @mos-easy-door header_regexp Host ${EASY_DOOR_HOME_HOST_REGEXP}
  handle @mos-easy-door {
    reverse_proxy 127.0.0.1:${suiteManagerPort}
  }
  handle {
    respond 404
  }
${unavailableHandler()}
}`;
}

function suiteManagerSite(siteAddress, suiteManagerPort) {
  return `${siteAddress} {
${statusRoutes()}
  reverse_proxy 127.0.0.1:${suiteManagerPort}
${unavailableHandler()}
}`;
}

// Trusted HTTPS on the Easy Door for one concrete LAN address: one wildcard,
// proved through the ACME responder, so every app alias under it shares it and
// none is ever ordered on its own. The named HTTP site is what keeps Caddy from
// redirecting the home name to HTTPS before the certificate exists, or forever
// when it never arrives. No ACME email of its own: the box has none at first boot.
function easyDoorTlsSites(address, suiteManagerPort) {
  const base = easyDoorBaseDomain(address);
  const homeHost = `home.${base}`;
  return `http://${homeHost} {
${statusRoutes()}
  reverse_proxy 127.0.0.1:${suiteManagerPort}
${unavailableHandler()}
}

https://*.${base} {
  tls {
    dns acmedns {
      server_url ${EASY_DOOR_ACME_SERVER}
      subdomain ${base.slice(0, -EASY_DOOR_ZONE.length - 1)}
      username mos
      password mos
    }
  }
${statusRoutes()}
  @mos-easy-door-home host ${homeHost}
  handle @mos-easy-door-home {
    reverse_proxy 127.0.0.1:${suiteManagerPort}
  }
  handle {
    respond 404
  }
${unavailableHandler()}
}`;
}

// Every Caddyfile MOS writes, as one function of the machine's facts. The
// installer bakes it with no Easy Door address, because the image cannot know
// the one it will get; the HTTPS agent re-renders it with the live address (and
// the Easy Door address still recorded, until the owner moves), and with the
// recorded domain when there is one.
//
// The install-time name and the Easy Door stay open for Suite Manager beside a
// domain: an owner who applied HTTPS from either door keeps a working page while
// their devices learn the new name. A public cloud install never has a door.
function renderCaddyfile({
  bootstrapHost = '$MOS_HOME_HOST',
  domain = null,
  easyDoorAddresses = [],
  publicCloud = false,
  suiteManagerPort = '$MOS_SUITE_MANAGER_PORT',
} = {}) {
  const sites = [suiteManagerSite(`http://${bootstrapHost}`, suiteManagerPort)];
  if (publicCloud) {
    sites.push(suiteManagerSite(`https://${bootstrapHost}`, suiteManagerPort));
  } else {
    sites.push(easyDoorSiteBlock(suiteManagerPort));
    for (const address of new Set(easyDoorAddresses.filter((address) => easyDoorBaseDomain(address)))) {
      sites.push(easyDoorTlsSites(address, suiteManagerPort));
    }
  }
  if (domain) {
    const homeHost = `home.${domain.baseDomain}`;
    sites.push(`http://${homeHost} {
  redir https://${homeHost}{uri} permanent
}`, suiteManagerSite(`https://${homeHost}`, suiteManagerPort));
  }
  const email = domain?.acmeEmail ? `  email ${domain.acmeEmail}\n` : '';
  const dnsChallenge = domain && !publicCloud ? '  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}\n' : '';
  const globals = email || dnsChallenge ? `{\n${email}${dnsChallenge}}\n\n` : '';
  return `${globals}${sites.join('\n\n')}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

// An installed machine's Caddyfile from where its facts live: the install
// contract, the recorded address and the live LAN address. Both writers render
// through here, the update path on every managed update and the HTTPS agent
// whenever they change, so neither can leave the file behind the other.
//
// The certificate follows the live address. The recorded Easy Door address
// keeps its own until the owner moves the suite, because its app routes are
// still served under it. `domain` is passed only by an apply that has not
// recorded the domain yet.
function renderMachineCaddyfile({ bootstrapHost, domain, frontDoor, liveAddress, recorded, suiteManagerPort }) {
  const recordedDomain = recorded?.kind === 'domain' ? { acmeEmail: recorded.acmeEmail, baseDomain: recorded.baseDomain } : null;
  const recordedEasyDoor = recorded?.kind === 'easy-door' ? easyDoorAddressOf(recorded.host) : null;
  return renderCaddyfile({
    bootstrapHost,
    domain: domain === undefined ? recordedDomain : domain,
    easyDoorAddresses: [liveAddress, recordedEasyDoor].filter(Boolean),
    publicCloud: hostingTrack(frontDoor) === 'public-server',
    suiteManagerPort,
  });
}

// The journal is where the reason something failed ends up, so both halves of
// this matter and neither was decided before.
//
// Persistence was already true by accident rather than by choice: Ubuntu ships
// `Storage=auto` and its systemd package creates /var/log/journal, and `auto`
// means persistent exactly when that directory exists. Stating it removes the
// dependency on a directory something else created — a restored machine
// reconstructs its state, and this is not a thing to rediscover then.
//
// The cap is the half that was genuinely missing. Upstream leaves SystemMaxUse
// unset, which means journald may grow to 10% of the filesystem: gigabytes on
// the small VPS this is most often installed on, on the same disk the apps and
// their backups need.
//
// Written from here by both paths that own host state — the installer at first
// boot and `reconcile-system.cjs` on every managed update — because a setting
// only the installer applied would never reach a machine that was updated rather
// than reflashed.
const JOURNALD_CONFIG_PATH = '/etc/systemd/journald.conf.d/mos.conf';

function renderJournaldConfig() {
  return `[Journal]
Storage=persistent
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=1month
`;
}

// Upstream serves "/" as rendered inside its own image build, against the stock
// config, until something revalidates it; every start re-renders it from ours.
// No "$" in this unit: the bootstrap writes it through an unquoted heredoc.
function renderHomepageSystemdUnit({
  homeHost = '$MOS_HOME_HOST',
  homepagePort = HOMEPAGE_PORT,
  stateRoot = '$MOS_STATE_ROOT',
} = {}) {
  return `[Unit]
Description=MOS Homepage dashboard
After=mos-vault.service docker.service network-online.target
Requires=mos-vault.service docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f mos-homepage
ExecStart=/usr/bin/docker run --rm --name mos-homepage --publish 127.0.0.1:${homepagePort}:3000 --env HOMEPAGE_ALLOWED_HOSTS=${homeHost} --volume ${stateRoot}/homepage/config:/app/config --volume ${stateRoot}/homepage/config/images:/app/public/images ${HOMEPAGE_IMAGE}
ExecStartPost=-/usr/bin/timeout 60 /bin/sh -c 'until curl -fsS -m 5 -o /dev/null -H "Host: localhost:3000" http://127.0.0.1:${homepagePort}/api/revalidate; do sleep 1; done'
ExecStop=/usr/bin/docker stop -t 10 mos-homepage

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
  CADDY_BUILD_IMAGES,
  CADDY_REQUIRED_MODULES,
  HOMEPAGE_IMAGE,
  HOMEPAGE_PORT,
  VAULT_AGENT_PORT,
  VAULT_UNLOCK_ROUTE,
  JOURNALD_CONFIG_PATH,
  PROGRESS_FILENAME,
  PROGRESS_ROUTE,
  PROGRESS_STALE_MINUTES,
  PUBLIC_CLOUD_FRONT_DOORS,
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  renderCaddyfile,
  renderUnavailablePage,
  renderUnavailablePageScript,
  renderJournaldConfig,
  renderMachineCaddyfile,
  renderHomepageSystemdUnit,
  hostingTrack,
};
