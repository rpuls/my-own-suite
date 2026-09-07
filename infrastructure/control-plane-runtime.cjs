const { EASY_DOOR_CADDY_MARKER, EASY_DOOR_HOME_HOST_REGEXP } = require('../shared/easy-door.cjs');

const HOMEPAGE_IMAGE = 'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a';
const HOMEPAGE_PORT = 3200;

const UNAVAILABLE_PAGE_ROOT = '/etc/caddy/mos-status';
const UNAVAILABLE_PAGE_FILENAME = 'unavailable.html';

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
// that proxies Suite Manager and has no handler yet gets one, whichever of the
// three renderings produced it. A file that already has them comes back
// unchanged, so this is safe to run on every reconcile. Blocks are found by
// brace depth rather than by matching a known rendering, because the installed
// file has been through `envsubst` and names a real host and port.
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
  // Late blocks first, so an insertion never moves the next block's indices.
  for (const block of blocks.reverse()) {
    const body = updated.slice(block.start, block.end + 1).join('\n');
    if (!/reverse_proxy\s+127\.0\.0\.1:/u.test(body) || /handle_errors/u.test(body)) continue;
    updated = [
      ...updated.slice(0, block.end),
      ...unavailableHandler().split('\n'),
      ...updated.slice(block.end),
    ];
  }
  return updated.join('\n');
}

// Served by Caddy with nothing else running, so it carries no script, no font,
// and no image — a page that reached for any of those would be a second broken
// request during the outage it exists to explain. It refreshes itself because
// the owner's next move is otherwise to keep pressing reload on a dead tab.
//
// The wording covers every reason the control plane can be down, because Caddy
// cannot tell them apart. Naming a restore alone would be a guess, and a wrong
// one is worse here than a general answer.
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
    background: #f6f7f9;
    color: #1b1d21;
    display: flex;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    min-height: 100vh;
    padding: 24px;
  }
  main { margin: auto; max-width: 30rem; }
  h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; }
  .meta { color: #5b6169; font-size: 0.9rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #15171a; color: #e8eaed; }
    .meta { color: #9aa1ab; }
  }
</style>
</head>
<body>
<main>
<h1>My Own Suite is busy right now</h1>
<p>The server is running, but Suite Manager is not answering yet.</p>
<p>If you started a restore or an update, this is expected — it is stopped on purpose while that finishes, and comes back on its own.</p>
<p class="meta">This page checks again every 15 seconds. Nothing is lost while it waits.</p>
</main>
</body>
</html>
`;
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
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
${unavailableHandler()}
}

${EASY_DOOR_CADDY_MARKER}
http:// {
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
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
${unavailableHandler()}
}

https://$MOS_HOME_HOST {
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
  reverse_proxy 127.0.0.1:${suiteManagerPort}
${unavailableHandler()}
}

http://${homeHost} {
  redir https://${homeHost}{uri} permanent
}

https://${homeHost} {
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
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  renderCaddyfile,
  renderUnavailablePage,
  withUnavailableHandler,
  renderJournaldConfig,
  renderHttpsCaddyfile,
  renderHomepageSystemdUnit,
  renderPublicCloudCaddyfile,
};
