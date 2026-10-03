const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CADDY_REQUIRED_MODULES,
  HOMEPAGE_IMAGE,
  PROGRESS_FILENAME,
  PROGRESS_ROUTE,
  PROGRESS_STALE_MINUTES,
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  renderCaddyfile,
  renderUnavailablePage,
  renderUnavailablePageScript,
  renderHomepageSystemdUnit,
  renderMachineCaddyfile,
} = require('../../infrastructure/control-plane-runtime.cjs');

test('Caddy exposes the single Home origin only through Suite Manager', () => {
  const caddyfile = renderCaddyfile();

  assert.match(caddyfile, /http:\/\/\$MOS_HOME_HOST/);
  assert.doesNotMatch(caddyfile, /MOS_SUITE_MANAGER_HOST/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:\$MOS_SUITE_MANAGER_PORT/);
  assert.match(caddyfile, /import \/etc\/caddy\/mos-homepage-routes\.caddy/);
  assert.doesNotMatch(caddyfile, /3200|homepage:3000|reverse_proxy\s+homepage/);
});

test('the Easy Door serves Suite Manager without changing what an unmatched host gets', () => {
  const caddyfile = renderCaddyfile();

  assert.match(caddyfile, /# mos-easy-door\nhttp:\/\/ \{/u);
  assert.match(caddyfile, /@mos-easy-door header_regexp Host \^home\\\./u);
  // Two site blocks, one upstream: the Easy Door is an alias for the same Suite
  // Manager, never a second thing to keep in step.
  assert.equal((caddyfile.match(/reverse_proxy 127\.0\.0\.1:\$MOS_SUITE_MANAGER_PORT/gu) || []).length, 2);
  // A request to the bare address still 404s, which the image verification in
  // `image-builder/` relies on to tell a healthy machine from a matched host.
  assert.match(caddyfile, /handle \{\n {4}respond 404\n {2}\}/u);
});

// A door is not an address. An owner who applied HTTPS while standing on the
// Easy Door or the install-time name keeps a working Suite Manager page there;
// only the apps move to the domain. A cloud install never had the door.
test('the Easy Door and the install-time name stay open for Suite Manager under a domain, and never open on a cloud install', () => {
  const https = renderCaddyfile({ bootstrapHost: 'home.mos.home', domain: { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com' }, suiteManagerPort: '3100' });

  assert.match(https, /# mos-easy-door\nhttp:\/\/ \{/u);
  assert.match(https, /@mos-easy-door header_regexp Host \^home\\\./u);
  assert.match(https, /http:\/\/home\.mos\.home \{/u);
  assert.match(https, /https:\/\/home\.mos\.example\.com \{/u);
  // Three site blocks proxy to the one Suite Manager: the install-time name, the
  // Easy Door and the domain; the port is the resolved one throughout.
  assert.equal((https.match(/reverse_proxy 127\.0\.0\.1:3100/gu) || []).length, 3);
  assert.doesNotMatch(https, /\$MOS_SUITE_MANAGER_PORT/u);
  assert.doesNotMatch(renderCaddyfile({ publicCloud: true }), /mos-easy-door|myownsuite\.org/u);
});

test('public-cloud Caddy serves diagnostics on HTTP and owner setup on automatic HTTPS', () => {
  const caddyfile = renderCaddyfile({ publicCloud: true });
  assert.match(caddyfile, /http:\/\/\$MOS_HOME_HOST/u);
  assert.match(caddyfile, /https:\/\/\$MOS_HOME_HOST/u);
  assert.equal((caddyfile.match(/reverse_proxy 127\.0\.0\.1:\$MOS_SUITE_MANAGER_PORT/gu) || []).length, 2);
  assert.doesNotMatch(caddyfile, /redir/u);
});

test('HTTPS Caddy rendering preserves bootstrap recovery and has no Homepage bypass or secret', () => {
  const caddyfile = renderCaddyfile({ bootstrapHost: 'home.203.0.113.42.sslip.io', domain: { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com' }, suiteManagerPort: '3100' });

  assert.match(caddyfile, /http:\/\/home\.203\.0\.113\.42\.sslip\.io/);
  assert.match(caddyfile, /http:\/\/home\.mos\.example\.com/);
  assert.match(caddyfile, /redir https:\/\/home\.mos\.example\.com\{uri\} permanent/);
  assert.match(caddyfile, /https:\/\/home\.mos\.example\.com/);
  assert.match(caddyfile, /acme_dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}/);
  assert.match(caddyfile, /import \/etc\/caddy\/mos-homepage-routes\.caddy/);
  assert.doesNotMatch(caddyfile, /3200|very-secret/u);
});

test('Caddy build pins the builder digest, Caddy version, and both DNS modules by tag', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'infrastructure', 'caddy', 'Dockerfile'), 'utf8');
  const [, builder, xcaddy] = /caddy:(2\.\d+\.\d+)-builder@sha256:[a-f0-9]{64}[\s\S]*xcaddy build v(2\.\d+\.\d+)/u.exec(dockerfile) || [];
  assert.equal(builder, xcaddy, 'the builder image and the built version are one version');
  // 2.10 let a domain's global acme_dns override the wildcard's own provider.
  assert.ok(Number(builder.split('.')[1]) >= 11, `Caddy ${builder} is older than 2.11`);
  assert.match(dockerfile, /github\.com\/caddy-dns\/cloudflare@v\d+\.\d+\.\d+/u);
  assert.match(dockerfile, /github\.com\/caddy-dns\/acmedns@v\d+\.\d+\.\d+/u);
  assert.deepEqual(CADDY_REQUIRED_MODULES, ['dns.providers.cloudflare', 'dns.providers.acmedns']);
  assert.doesNotMatch(dockerfile, /BUILDPLATFORM/u);
  assert.doesNotMatch(dockerfile, /latest/u);
});

test('an Easy Door address gets one wildcard through the ACME responder and a named HTTP door', () => {
  const caddyfile = renderCaddyfile({ bootstrapHost: 'home.mos.home', easyDoorAddresses: ['192.168.68.123'], suiteManagerPort: '3100' });

  assert.match(caddyfile, /^http:\/\/home\.192-168-68-123\.local\.myownsuite\.org \{\n[\s\S]*?reverse_proxy 127\.0\.0\.1:3100/mu);
  assert.match(caddyfile, /^https:\/\/\*\.192-168-68-123\.local\.myownsuite\.org \{\n {2}tls \{\n {4}dns acmedns \{\n {6}server_url https:\/\/acme\.myownsuite\.org\n {6}subdomain 192-168-68-123\n/mu);
  assert.match(caddyfile, /@mos-easy-door-home host home\.192-168-68-123\.local\.myownsuite\.org/u);
  // No email and no global options before a domain: the box has no owner address at first boot.
  assert.doesNotMatch(caddyfile, /email|acme_dns|auto_https/u);
  assert.equal(caddyfile.match(/handle_errors/gu).length, 4);
});

test('only private Easy Door addresses render, each once, and never on a public cloud install', () => {
  const caddyfile = renderCaddyfile({ easyDoorAddresses: ['192.168.1.5', '192.168.1.5', '203.0.113.9', '10.0.0.7'] });
  assert.deepEqual(caddyfile.match(/^https:\/\/\S+/gmu), ['https://*.192-168-1-5.local.myownsuite.org', 'https://*.10-0-0-7.local.myownsuite.org']);
  assert.doesNotMatch(renderCaddyfile({ easyDoorAddresses: ['192.168.1.5'], publicCloud: true }), /myownsuite\.org/u);
});

test('a domain keeps its global Cloudflare challenge beside the Easy Door wildcard', () => {
  const caddyfile = renderCaddyfile({ domain: { acmeEmail: 'owner@example.com', baseDomain: 'example.com' }, easyDoorAddresses: ['192.168.1.5'] });
  assert.match(caddyfile, /^\{\n {2}email owner@example\.com\n {2}acme_dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}\n\}/u);
  assert.match(caddyfile, /dns acmedns \{/u);
  assert.match(caddyfile, /^https:\/\/home\.example\.com \{/mu);
});

test('a machine\'s Caddyfile follows the live address and keeps the recorded Easy Door until the owner moves', () => {
  const facts = { bootstrapHost: 'home.mos.home', frontDoor: 'usb-autoinstall', liveAddress: '192.168.1.9', suiteManagerPort: '3100' };
  const sites = (caddyfile) => caddyfile.match(/^https:\/\/\S+/gmu);

  assert.deepEqual(sites(renderMachineCaddyfile({ ...facts, recorded: { host: 'home.192-168-1-5.local.myownsuite.org', kind: 'easy-door', scheme: 'https' } })), [
    'https://*.192-168-1-9.local.myownsuite.org',
    'https://*.192-168-1-5.local.myownsuite.org',
  ]);
  const onDomain = renderMachineCaddyfile({ ...facts, recorded: { acmeEmail: 'owner@example.com', baseDomain: 'example.com', host: 'home.example.com', kind: 'domain', scheme: 'https' } });
  assert.deepEqual(sites(onDomain), ['https://*.192-168-1-9.local.myownsuite.org', 'https://home.example.com']);
  // An apply renders the domain it is about to record.
  const applying = renderMachineCaddyfile({ ...facts, domain: { acmeEmail: 'owner@example.com', baseDomain: 'new.example' }, recorded: null });
  assert.match(applying, /^https:\/\/home\.new\.example \{/mu);
  assert.equal(renderMachineCaddyfile({ ...facts, frontDoor: 'cloud-init', liveAddress: '10.0.0.5', recorded: null }), renderCaddyfile({ bootstrapHost: 'home.mos.home', publicCloud: true, suiteManagerPort: '3100' }));
});

test('Homepage runtime is pinned and reachable only through loopback', () => {
  const unit = renderHomepageSystemdUnit();

  assert.match(HOMEPAGE_IMAGE, /^ghcr\.io\/gethomepage\/homepage@sha256:[a-f0-9]{64}$/);
  assert.match(unit, /--publish 127\.0\.0\.1:3200:3000/);
  assert.match(unit, /HOMEPAGE_ALLOWED_HOSTS=\$MOS_HOME_HOST/);
  assert.match(unit, /\/homepage\/config:\/app\/config/);
  assert.match(unit, /\/homepage\/config\/images:\/app\/public\/images/);
  assert.doesNotMatch(unit, /0\.0\.0\.0:3200|--network host/);
});

test('every Homepage start re-renders its root page from the MOS config', () => {
  const unit = renderHomepageSystemdUnit({ homepagePort: '3200' });

  assert.match(unit, /^ExecStartPost=-\/usr\/bin\/timeout 60 .*-H "Host: localhost:3000" http:\/\/127\.0\.0\.1:3200\/api\/revalidate/mu);
});

test('the Homepage unit survives the unquoted heredoc the bootstrap writes it through', () => {
  const unit = renderHomepageSystemdUnit({ homeHost: 'home.mos.home', homepagePort: '3200', stateRoot: '/var/lib/mos' });

  assert.doesNotMatch(unit, /[$`\\]/u);
});

test('Homepage runtime can render concrete update reconciliation paths', () => {
  const unit = renderHomepageSystemdUnit({
    homeHost: 'home.mos.home',
    homepagePort: '3200',
    stateRoot: '/var/lib/mos',
  });

  assert.match(unit, /HOMEPAGE_ALLOWED_HOSTS=home\.mos\.home/);
  assert.match(unit, /--volume \/var\/lib\/mos\/homepage\/config:\/app\/config/);
  assert.match(unit, /--volume \/var\/lib\/mos\/homepage\/config\/images:\/app\/public\/images/);
  assert.doesNotMatch(unit, /\$MOS_(HOME_HOST|STATE_ROOT|HOMEPAGE_PORT)/u);
});

test('Homepage ships useful defaults and an editable source template without overlay account controls', () => {
  const configDir = path.join(__dirname, '..', '..', 'infrastructure', 'homepage');
  const services = fs.readFileSync(path.join(configDir, 'services.yaml'), 'utf8');
  const template = fs.readFileSync(path.join(configDir, 'services.template.yaml'), 'utf8');
  const widgets = fs.readFileSync(path.join(configDir, 'widgets.yaml'), 'utf8');
  const bookmarks = fs.readFileSync(path.join(configDir, 'bookmarks.yaml'), 'utf8');
  const customJavaScript = fs.readFileSync(path.join(configDir, 'custom.js'), 'utf8');
  const customCss = fs.readFileSync(path.join(configDir, 'custom.css'), 'utf8');

  for (const content of [services, template]) {
    assert.match(content, /href: \/suite-manager\//);
    assert.match(content, /href: https:\/\/www\.funkyton\.com/);
    assert.match(content, /icon: \/images\/my-own-suite-mark\.png/);
    assert.match(content, /icon: \/images\/funkyton-F-icon\.png/);
  }
  assert.match(widgets, /www\.startpage\.com\/sp\/search/);
  assert.match(bookmarks, /github\.com\/rpuls\/my-own-suite/);
  assert.match(bookmarks, /discord\.gg\/YMpF6faBCv/);
  assert.match(bookmarks, /icon: \/images\/github\.svg/);
  assert.match(bookmarks, /icon: \/images\/discord\.svg/);
  assert.match(bookmarks, /icon: \/images\/my-own-suite-mark\.png/);
  assert.match(bookmarks, /- Releases:/);
  assert.match(bookmarks, /- Social:/);
  assert.match(bookmarks, /- Docs:/);
  assert.match(customJavaScript, /root\.classList\.add\(desiredTheme\)/);
  assert.doesNotMatch(customJavaScript, /Sign out|createElement|mos-dashboard-toolbar/);
  assert.match(customCss, /\.bookmark-group a/);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'my-own-suite-mark.png')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'funkyton-F-icon.png')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'github.svg')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'discord.svg')), true);
});

// Suite Manager is stopped on purpose for the middle of a restore, and the
// drills found that an owner refreshing the page then met Caddy's bare 502 —
// the one screen in recovery that explained nothing.
test('every Suite Manager entrance answers a control-plane outage with the status page', () => {
  const expected = new RegExp(
    String.raw`handle_errors \{\s*root \* ${UNAVAILABLE_PAGE_ROOT}\s*`
    + String.raw`rewrite \* /${UNAVAILABLE_PAGE_FILENAME}\s*`
    + String.raw`header Retry-After 15\s*`
    + String.raw`file_server \{\s*status 503`,
    'u',
  );

  // Both doors on a default install: the Home host and the Easy Door.
  const defaultFile = renderCaddyfile();
  assert.equal(defaultFile.match(/handle_errors/gu).length, 2);
  assert.match(defaultFile, expected);

  const cloud = renderCaddyfile({ publicCloud: true });
  assert.equal(cloud.match(/handle_errors/gu).length, 2);
  assert.match(cloud, expected);

  // On HTTPS, the three proxying blocks get it; the plain-HTTP redirect has no
  // upstream to fail, so it stays a redirect.
  const https = renderCaddyfile({ bootstrapHost: 'boot.example.com', domain: { acmeEmail: 'owner@example.com', baseDomain: 'example.com' } });
  assert.equal(https.match(/handle_errors/gu).length, 3);
  assert.match(https, expected);
  assert.match(https, /http:\/\/home\.example\.com \{\s*redir https:\/\/home\.example\.com\{uri\} permanent\s*\}/u);
});

test('the status page stands alone and asks the browser to come back', () => {
  const page = renderUnavailablePage();

  // Caddy serves this with nothing else running, so anything it referenced
  // would be a second broken request during the outage it explains. The one
  // script is inline, and the one thing it fetches is Caddy's own file.
  assert.doesNotMatch(page, /<script src|<img|<link|https?:\/\//u);
  assert.match(page, /<meta http-equiv="refresh" content="15">/u);
  assert.match(page, /<title>[^<]+<\/title>/u);
  assert.match(page, /restore or an update/u);
  assert.match(page, /prefers-color-scheme: dark/u);
  assert.ok(page.includes(renderUnavailablePageScript()), 'the page carries the script verbatim');
  assert.equal(page.match(/fetch\(/gu).length, 1);
  assert.ok(page.includes(`fetch('${PROGRESS_ROUTE}'`));

  // With no script running, the progress section is hidden markup and the
  // page is the static one it always was: the words come before the script.
  const staticText = page.slice(0, page.indexOf('<script>'));
  assert.match(staticText, /My Own Suite is busy right now/u);
  assert.match(staticText, /Nothing is lost while it waits/u);
  assert.match(staticText, /<section id="mos-progress" hidden/u);
});

// The route the page polls. It is matched before the proxy, so it never
// depends on the error path: with the file present it is served, without it
// the answer is an empty 204, and neither is an error `handle_errors` would
// rewrite into the HTML page.
test('the progress file has its own route in every proxying block, ahead of the proxy and outside the error handler', () => {
  const route = new RegExp(String.raw`handle ${PROGRESS_ROUTE.replace(/\./gu, '\\.')} \{\s*root \* ${UNAVAILABLE_PAGE_ROOT}\s*@present file /${PROGRESS_FILENAME.replace(/\./gu, '\\.')}\s*handle @present \{\s*header Cache-Control no-store\s*rewrite \* /${PROGRESS_FILENAME.replace(/\./gu, '\\.')}\s*file_server\s*\}\s*handle \{\s*respond 204\s*\}\s*\}`, 'u');
  const renderings = {
    cloud: renderCaddyfile({ publicCloud: true }),
    default: renderCaddyfile(),
    https: renderCaddyfile({ bootstrapHost: 'boot.example.com', domain: { acmeEmail: 'owner@example.com', baseDomain: 'example.com' } }),
    easyDoor: renderCaddyfile({ easyDoorAddresses: ['192.168.1.5'] }),
  };
  const proxyingBlocks = { cloud: 2, default: 2, easyDoor: 4, https: 3 };
  for (const [name, rendered] of Object.entries(renderings)) {
    assert.match(rendered, route, `${name}: the route is rendered in full`);
    assert.equal(rendered.match(/handle \/mos-status\/progress\.json \{/gu).length, proxyingBlocks[name], `${name}: one route per proxying block`);
    for (const block of siteBlocks(rendered)) {
      const proxies = /reverse_proxy\s+127\.0\.0\.1:/u.test(block);
      const routeAt = block.indexOf(`handle ${PROGRESS_ROUTE} {`);
      if (!proxies) {
        assert.equal(routeAt, -1, `${name}: a block with no upstream has no route`);
        continue;
      }
      assert.ok(routeAt >= 0, `${name}: a proxying block has the route`);
      assert.ok(routeAt < block.indexOf('reverse_proxy'), `${name}: the route comes before the proxy`);
      assert.ok(routeAt < block.indexOf('handle_errors'), `${name}: the route is not inside the error handler`);
      // Inside the Easy Door the proxy sits in a `handle @mos-easy-door`;
      // the route has to be a sibling ahead of it, not nested in it.
      if (block.includes('@mos-easy-door')) assert.ok(routeAt < block.indexOf('@mos-easy-door'));
    }
  }
});

// Top-level `{ ... }` blocks of a Caddyfile, by brace depth.
function siteBlocks(caddyfile) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  const lines = caddyfile.split('\n');
  lines.forEach((line, index) => {
    const opens = (line.match(/\{/gu) || []).length;
    const closes = (line.match(/\}/gu) || []).length;
    if (depth === 0 && opens > closes) start = index;
    depth = Math.max(0, depth + opens - closes);
    if (depth === 0 && start !== -1) {
      blocks.push(lines.slice(start, index + 1).join('\n'));
      start = -1;
    }
  });
  return blocks;
}

// The page's script, run against a fake document: the page must render
// correctly with no file, with the HTML page where JSON was expected, with
// malformed JSON, and with a file a dead worker left behind. Only a fresh,
// well-formed file makes the section appear.
class FakeNode {
  constructor(tag) {
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.style = {};
    this.tag = tag;
    this.textContent = '';
  }

  get firstChild() { return this.children[0] || null; }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children = this.children.filter((child) => child !== node); return node; }
}

function runPageScript(responder) {
  const ids = ['mos-progress', 'mos-progress-headline', 'mos-progress-now', 'mos-progress-count', 'mos-progress-bar', 'mos-progress-fill', 'mos-progress-note', 'mos-progress-plan', 'mos-progress-expect'];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id)]));
  nodes.get('mos-progress').hidden = true;
  const document = { createElement: (tag) => new FakeNode(tag), getElementById: (id) => nodes.get(id) || null };
  const fetch = (url, options) => {
    assert.equal(url, PROGRESS_ROUTE);
    assert.deepEqual(options, { cache: 'no-store' });
    return Promise.resolve().then(() => responder());
  };
  const timers = [];
  const script = new Function('document', 'fetch', 'setInterval', renderUnavailablePageScript());
  script(document, fetch, (callback, ms) => timers.push({ callback, ms }));
  return { nodes, timers };
}

// The plan as the page drew it: one row per group, with the lines inside the
// groups that are open. A group with no parts is a row with text and nothing
// to open.
function planRows(list) {
  return list.children.map((item) => {
    const detail = item.children[0];
    if (!detail) return { open: null, state: item.className, steps: [], title: item.textContent };
    const [summary, sub] = detail.children;
    return {
      open: detail.open === true,
      state: item.className,
      steps: sub.children.map((row) => [row.className, row.textContent]),
      title: summary.textContent,
    };
  });
}

function response({ body = '', ok = true, status = 200, type = 'application/json' }) {
  return { headers: { get: () => type }, json: async () => JSON.parse(body), ok, status };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function freshProgress(overrides = {}) {
  const now = new Date().toISOString();
  return {
    count: { current: 'ONLYOFFICE', done: 2, note: 'ONLYOFFICE usually takes 6 minutes on this machine.', sentence: 'ONLYOFFICE — 3 of 6 apps', total: 6 },
    expect: { sentence: 'On this machine this usually takes about 19 minutes.' },
    headline: 'Restoring your backup',
    plan: [
      { sentence: 'Reading the backup', state: 'done', steps: [{ sentence: 'Checking nothing in it is damaged', state: 'done' }, { sentence: 'Reading your settings and accounts', state: 'done' }] },
      { sentence: 'Putting your suite back', state: 'now', steps: [{ sentence: 'Putting your app data back', state: 'done' }, { sentence: 'Building your apps again', state: 'now' }] },
      { sentence: 'Checking it and starting it', state: 'next', steps: [] },
    ],
    sentence: 'Building your apps again',
    startedAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
    step: 3,
    steps: 4,
    updatedAt: now,
    ...overrides,
  };
}

test('the status page shows nothing extra with no progress file, an HTML answer, or malformed JSON', async () => {
  for (const answer of [
    () => response({ ok: true, status: 204, type: '' }),
    () => response({ body: '<!doctype html>', ok: false, status: 503, type: 'text/html; charset=utf-8' }),
    () => response({ body: '{not json', status: 200 }),
    () => response({ body: '"a string"', status: 200 }),
    () => response({ body: JSON.stringify({ headline: 'Restoring your backup' }), status: 200 }),
    () => { throw new Error('network down'); },
    () => Promise.reject(new Error('aborted')),
  ]) {
    const { nodes } = runPageScript(answer);
    await settle();
    assert.equal(nodes.get('mos-progress').hidden, true);
    assert.equal(nodes.get('mos-progress-headline').textContent, '');
  }
});

test('the status page shows the stage, the counts, the plan and the expectation from a fresh file', async () => {
  const { nodes, timers } = runPageScript(() => response({ body: JSON.stringify(freshProgress()) }));
  await settle();
  assert.equal(nodes.get('mos-progress').hidden, false);
  assert.equal(nodes.get('mos-progress-headline').textContent, 'Restoring your backup');
  assert.equal(nodes.get('mos-progress-now').textContent, 'Building your apps again — step 3 of 4');
  assert.equal(nodes.get('mos-progress-count').textContent, 'ONLYOFFICE — 3 of 6 apps');
  assert.equal(nodes.get('mos-progress-count').hidden, false);
  assert.equal(nodes.get('mos-progress-note').textContent, 'ONLYOFFICE usually takes 6 minutes on this machine.');
  assert.equal(nodes.get('mos-progress-bar').hidden, false);
  assert.equal(nodes.get('mos-progress-fill').style.width, '33%');
  // The group that is running is open; the one that is done is not, and the
  // one that has not started has nothing to open yet.
  assert.deepEqual(planRows(nodes.get('mos-progress-plan')), [
    {
      open: false,
      state: 'is-done',
      steps: [['is-done', 'Checking nothing in it is damaged'], ['is-done', 'Reading your settings and accounts']],
      title: 'Reading the backup',
    },
    {
      open: true,
      state: 'is-now',
      steps: [['is-done', 'Putting your app data back'], ['is-now', 'Building your apps again']],
      title: 'Putting your suite back',
    },
    { open: null, state: 'is-next', steps: [], title: 'Checking it and starting it' },
  ]);
  assert.equal(nodes.get('mos-progress-expect').textContent, 'On this machine this usually takes about 19 minutes. Started 9 minutes ago.');
  // It keeps asking, and a single-step job says no step count.
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);

  const single = runPageScript(() => response({ body: JSON.stringify(freshProgress({ count: null, expect: null, headline: 'Checking a backup', plan: [{ sentence: 'Reading the backup', state: 'now', steps: [] }], sentence: 'Reading the backup', step: 1, steps: 1 })) }));
  await settle();
  assert.equal(single.nodes.get('mos-progress-now').textContent, 'Reading the backup');
  assert.equal(single.nodes.get('mos-progress-bar').hidden, true);
  assert.equal(single.nodes.get('mos-progress-count').hidden, true);
  assert.equal(single.nodes.get('mos-progress-fill').style.width, '0%');
});

// The page re-reads the file every few seconds. Rebuilding the list each time
// would shut a group the owner opened to read, so the rows are kept and only
// a group that has actually moved is opened or folded away.
test('the running group opens itself, and a group opened by hand survives the next poll', async () => {
  const moved = (states) => freshProgress({
    plan: [
      { sentence: 'Reading the backup', state: states[0], steps: [{ sentence: 'Checking nothing in it is damaged', state: 'done' }] },
      { sentence: 'Putting your suite back', state: states[1], steps: [{ sentence: 'Building your apps again', state: states[1] === 'done' ? 'done' : 'now' }] },
      { sentence: 'Checking it and starting it', state: states[2], steps: [{ sentence: 'Starting the restored server', state: states[2] === 'now' ? 'now' : 'next' }] },
    ],
  });
  const answers = [moved(['done', 'now', 'next']), moved(['done', 'now', 'next']), moved(['done', 'done', 'now'])];
  let poll = 0;
  const { nodes, timers } = runPageScript(() => response({ body: JSON.stringify(answers[Math.min(poll++, answers.length - 1)]) }));
  await settle();
  const list = nodes.get('mos-progress-plan');
  assert.deepEqual(planRows(list).map((row) => row.open), [false, true, false]);

  // Opened by hand, then a poll that changes nothing.
  const rows = list.children;
  rows[0].children[0].open = true;
  timers[0].callback();
  await settle();
  assert.deepEqual(planRows(list).map((row) => row.open), [true, true, false], 'a poll that changes nothing leaves the rows alone');
  assert.equal(list.children[0], rows[0], 'the rows are the same nodes, not rebuilt ones');

  // The job moves on: the group that finished folds away and the next opens,
  // whatever the owner had done to them.
  timers[0].callback();
  await settle();
  assert.deepEqual(planRows(list).map((row) => row.open), [true, false, true]);
  assert.deepEqual(planRows(list).map((row) => row.state), ['is-done', 'is-done', 'is-now']);
});

test('a progress file a dead worker left behind does not make the page claim a job is running', async () => {
  const stale = new Date(Date.now() - (PROGRESS_STALE_MINUTES + 1) * 60 * 1000).toISOString();
  const { nodes } = runPageScript(() => response({ body: JSON.stringify(freshProgress({ updatedAt: stale })) }));
  await settle();
  assert.equal(nodes.get('mos-progress').hidden, true);

  // And a file that appears fresh, then goes stale between polls, disappears.
  let updatedAt = new Date().toISOString();
  const live = runPageScript(() => response({ body: JSON.stringify(freshProgress({ updatedAt })) }));
  await settle();
  assert.equal(live.nodes.get('mos-progress').hidden, false);
  updatedAt = stale;
  live.timers[0].callback();
  await settle();
  assert.equal(live.nodes.get('mos-progress').hidden, true);
});
