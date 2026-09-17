const { EASY_DOOR_CADDY_MARKER, EASY_DOOR_HOME_HOST_REGEXP } = require('../shared/easy-door.cjs');

const HOMEPAGE_IMAGE = 'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a';
const HOMEPAGE_PORT = 3200;

const UNAVAILABLE_PAGE_ROOT = '/etc/caddy/mos-status';
const UNAVAILABLE_PAGE_FILENAME = 'unavailable.html';
// Written by the backup agent while a job runs, removed when it ends, and
// polled by the status page below. The agent decides the words; both surfaces
// only render what it wrote.
const PROGRESS_FILENAME = 'progress.json';
const PROGRESS_ROUTE = `/mos-status/${PROGRESS_FILENAME}`;
const PROGRESS_STALE_MINUTES = 30;

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

// An installed machine's Caddyfile is written once and then belongs to whatever
// last rendered it — applying HTTPS replaces the whole file — which is why
// reconciliation deliberately never rewrites it. That would have left the status
// handler reaching new installs only, and a managed update that applies half of
// a change is a regression rather than a limitation.
//
// So the file that is already there is upgraded in place: every top-level block
// that proxies Suite Manager gets the progress route at its start and the error
// handler at its end, whichever it is missing and whichever of the three
// renderings produced it. A file that already has both comes back unchanged,
// so this is safe to run on every reconcile. Blocks are found by brace depth
// rather than by matching a known rendering, because the installed file has
// been through `envsubst` and names a real host and port.
//
// The handler goes at the end of the site block, never beside the `reverse_proxy`
// line: in the Easy Door block that line sits inside a `handle`, and
// `handle_errors` is not valid there.
function withUnavailableHandler(caddyfile) {
  const lines = caddyfile.split(/\r?\n/u);
  const blocks = [];
  let depth = 0;
  let start = -1;

  lines.forEach((line, index) => {
    const opens = (line.match(/\{/gu) || []).length;
    const closes = (line.match(/\}/gu) || []).length;
    if (depth === 0 && opens > closes) start = index;
    depth = Math.max(0, depth + opens - closes);
    if (depth === 0 && start !== -1) {
      blocks.push({ end: index, start });
      start = -1;
    }
  });

  let updated = lines;
  // Late blocks first, and the end of a block before its start, so an
  // insertion never moves an index still to be used.
  for (const block of blocks.reverse()) {
    const body = updated.slice(block.start, block.end + 1).join('\n');
    if (!/reverse_proxy\s+127\.0\.0\.1:/u.test(body)) continue;
    if (!/handle_errors/u.test(body)) {
      updated = [
        ...updated.slice(0, block.end),
        ...unavailableHandler().split('\n'),
        ...updated.slice(block.end),
      ];
    }
    if (!body.includes(PROGRESS_ROUTE)) {
      updated = [
        ...updated.slice(0, block.start + 1),
        ...progressRoute().split('\n'),
        ...updated.slice(block.start + 1),
      ];
    }
  }
  return updated.join('\n');
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
  #mos-progress-plan { list-style: none; margin: 0 0 0.75rem; padding: 0; }
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
    if (list) {
      while (list.firstChild) list.removeChild(list.firstChild);
      for (var i = 0; i < data.plan.length; i += 1) {
        var entry = data.plan[i];
        if (!entry || typeof entry.sentence !== 'string') continue;
        var item = document.createElement('li');
        item.className = 'is-' + (entry.state === 'done' || entry.state === 'now' ? entry.state : 'next');
        item.textContent = entry.sentence;
        list.appendChild(item);
      }
      list.hidden = !list.firstChild;
    }
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
// Nothing closes this door explicitly: applying a real domain with DNS-01
// replaces this whole file with `renderHttpsCaddyfile()` output, which has no
// Easy Door block, and plain HTTP on a globally resolvable name stops being
// served the moment there is a better address.
function renderCaddyfile() {
  return `http://$MOS_HOME_HOST {
${progressRoute()}
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
${unavailableHandler()}
}

${EASY_DOOR_CADDY_MARKER}
http:// {
${progressRoute()}
  @mos-easy-door header_regexp Host ${EASY_DOOR_HOME_HOST_REGEXP}
  handle @mos-easy-door {
    reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
  }
  handle {
    respond 404
  }
${unavailableHandler()}
}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

function renderPublicCloudCaddyfile() {
  return `http://$MOS_HOME_HOST {
${progressRoute()}
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
${unavailableHandler()}
}

https://$MOS_HOME_HOST {
${progressRoute()}
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
${unavailableHandler()}
}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

function renderHttpsCaddyfile({ acmeEmail, baseDomain, bootstrapHost, suiteManagerPort = '$MOS_SUITE_MANAGER_PORT' }) {
  const homeHost = `home.${baseDomain}`;
  return `{
  email ${acmeEmail}
  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}

http://${bootstrapHost} {
${progressRoute()}
  reverse_proxy 127.0.0.1:${suiteManagerPort}
${unavailableHandler()}
}

http://${homeHost} {
  redir https://${homeHost}{uri} permanent
}

https://${homeHost} {
${progressRoute()}
  reverse_proxy 127.0.0.1:${suiteManagerPort}
${unavailableHandler()}
}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
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

function renderHomepageSystemdUnit({
  homeHost = '$MOS_HOME_HOST',
  homepagePort = HOMEPAGE_PORT,
  stateRoot = '$MOS_STATE_ROOT',
} = {}) {
  return `[Unit]
Description=MOS Homepage dashboard
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f mos-homepage
ExecStart=/usr/bin/docker run --rm --name mos-homepage --publish 127.0.0.1:${homepagePort}:3000 --env HOMEPAGE_ALLOWED_HOSTS=${homeHost} --volume ${stateRoot}/homepage/config:/app/config --volume ${stateRoot}/homepage/config/images:/app/public/images ${HOMEPAGE_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 mos-homepage

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
  HOMEPAGE_IMAGE,
  HOMEPAGE_PORT,
  JOURNALD_CONFIG_PATH,
  PROGRESS_FILENAME,
  PROGRESS_ROUTE,
  PROGRESS_STALE_MINUTES,
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  renderCaddyfile,
  renderUnavailablePage,
  renderUnavailablePageScript,
  withUnavailableHandler,
  renderJournaldConfig,
  renderHttpsCaddyfile,
  renderHomepageSystemdUnit,
  renderPublicCloudCaddyfile,
};
