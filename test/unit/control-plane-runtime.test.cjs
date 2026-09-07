const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  HOMEPAGE_IMAGE,
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  renderCaddyfile,
  renderUnavailablePage,
  withUnavailableHandler,
  renderHttpsCaddyfile,
  renderPublicCloudCaddyfile,
  renderHomepageSystemdUnit,
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

test('the Easy Door closes when a real domain takes over, and never opens on a cloud install', () => {
  const https = renderHttpsCaddyfile({
    acmeEmail: 'owner@example.com',
    baseDomain: 'mos.example.com',
    bootstrapHost: 'home.mos.home',
    suiteManagerPort: '3100',
  });

  assert.doesNotMatch(https, /mos-easy-door|myownsuite\.org/u);
  assert.doesNotMatch(renderPublicCloudCaddyfile(), /mos-easy-door|myownsuite\.org/u);
});

test('public-cloud Caddy serves diagnostics on HTTP and owner setup on automatic HTTPS', () => {
  const caddyfile = renderPublicCloudCaddyfile();
  assert.match(caddyfile, /http:\/\/\$MOS_HOME_HOST/u);
  assert.match(caddyfile, /https:\/\/\$MOS_HOME_HOST/u);
  assert.equal((caddyfile.match(/reverse_proxy 127\.0\.0\.1:\$MOS_SUITE_MANAGER_PORT/gu) || []).length, 2);
  assert.doesNotMatch(caddyfile, /redir/u);
});

test('HTTPS Caddy rendering preserves bootstrap recovery and has no Homepage bypass or secret', () => {
  const caddyfile = renderHttpsCaddyfile({
    acmeEmail: 'owner@example.com',
    baseDomain: 'mos.example.com',
    bootstrapHost: 'home.203.0.113.42.sslip.io',
    suiteManagerPort: '3100',
  });

  assert.match(caddyfile, /http:\/\/home\.203\.0\.113\.42\.sslip\.io/);
  assert.match(caddyfile, /http:\/\/home\.mos\.example\.com/);
  assert.match(caddyfile, /redir https:\/\/home\.mos\.example\.com\{uri\} permanent/);
  assert.match(caddyfile, /https:\/\/home\.mos\.example\.com/);
  assert.match(caddyfile, /acme_dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}/);
  assert.match(caddyfile, /import \/etc\/caddy\/mos-homepage-routes\.caddy/);
  assert.doesNotMatch(caddyfile, /3200|very-secret/u);
});

test('Caddy build pins the builder digest, Caddy version, and Cloudflare module version', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'infrastructure', 'caddy', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /caddy:2\.10\.2-builder@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /xcaddy build v2\.10\.2/u);
  assert.match(dockerfile, /github\.com\/caddy-dns\/cloudflare@v0\.2\.4/u);
  assert.doesNotMatch(dockerfile, /BUILDPLATFORM/u);
  assert.doesNotMatch(dockerfile, /latest/u);
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

  const cloud = renderPublicCloudCaddyfile();
  assert.equal(cloud.match(/handle_errors/gu).length, 2);
  assert.match(cloud, expected);

  // On HTTPS, the two proxying blocks get it; the plain-HTTP redirect has no
  // upstream to fail, so it stays a redirect.
  const https = renderHttpsCaddyfile({ acmeEmail: 'owner@example.com', baseDomain: 'example.com', bootstrapHost: 'boot.example.com' });
  assert.equal(https.match(/handle_errors/gu).length, 2);
  assert.match(https, expected);
  assert.match(https, /http:\/\/home\.example\.com \{\s*redir https:\/\/home\.example\.com\{uri\} permanent\s*\}/u);
});

test('the status page stands alone and asks the browser to come back', () => {
  const page = renderUnavailablePage();

  // Caddy serves this with nothing else running, so anything it referenced
  // would be a second broken request during the outage it explains.
  assert.doesNotMatch(page, /<script|<img|<link|https?:\/\//u);
  assert.match(page, /<meta http-equiv="refresh" content="15">/u);
  assert.match(page, /<title>[^<]+<\/title>/u);
  assert.match(page, /restore or an update/u);
  assert.match(page, /prefers-color-scheme: dark/u);
});

// The installed Caddyfile is never re-rendered by reconciliation, because
// applying HTTPS owns that file. Without an in-place upgrade the status handler
// would have reached new installs only, which is a partly applied update.
const INSTALLED_BEFORE_THE_HANDLER = `http://home.mos.home {
  reverse_proxy 127.0.0.1:8890
}

# mos-easy-door
http:// {
  @mos-easy-door header_regexp Host ^home\.10-0-0-5\.local\.myownsuite\.org$
  handle @mos-easy-door {
    reverse_proxy 127.0.0.1:8890
  }
  handle {
    respond 404
  }
}
`;

const INSTALLED_HTTPS_BEFORE_THE_HANDLER = `{
  email owner@example.com
  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}

http://boot.example.com {
  reverse_proxy 127.0.0.1:8890
}

http://home.example.com {
  redir https://home.example.com{uri} permanent
}

https://home.example.com {
  reverse_proxy 127.0.0.1:8890
}
`;

test('an already-installed Caddyfile gains the handler in every proxying block', () => {
  const upgraded = withUnavailableHandler(INSTALLED_BEFORE_THE_HANDLER);
  assert.equal(upgraded.match(/handle_errors/gu).length, 2);

  // In the Easy Door the proxy sits inside a `handle`, where `handle_errors` is
  // not valid, so it has to land at the end of the site block instead.
  assert.match(upgraded, /  \}\n  handle_errors \{/u);
  assert.doesNotMatch(upgraded, /handle @mos-easy-door \{\s*\n\s*handle_errors/u);
});

test('the upgrade skips blocks with no upstream to fail', () => {
  const upgraded = withUnavailableHandler(INSTALLED_HTTPS_BEFORE_THE_HANDLER);
  assert.equal(upgraded.match(/handle_errors/gu).length, 2);

  // The global options block is not a site, and the plain-HTTP block only
  // redirects — neither can produce an upstream error.
  const beforeFirstSite = upgraded.slice(0, upgraded.indexOf('http://boot.example.com'));
  assert.doesNotMatch(beforeFirstSite, /handle_errors/u);
  const redirect = upgraded.slice(upgraded.indexOf('http://home.example.com {'), upgraded.indexOf('https://home.example.com {'));
  assert.doesNotMatch(redirect, /handle_errors/u);
});

test('the upgrade is a no-op on every current rendering and on its own output', () => {
  // Runs on every reconcile, so a second pass must never stack a second handler.
  for (const rendered of [
    renderCaddyfile(),
    renderPublicCloudCaddyfile(),
    renderHttpsCaddyfile({ acmeEmail: 'owner@example.com', baseDomain: 'example.com', bootstrapHost: 'boot.example.com' }),
  ]) {
    assert.equal(withUnavailableHandler(rendered), rendered);
  }

  const once = withUnavailableHandler(INSTALLED_BEFORE_THE_HANDLER);
  assert.equal(withUnavailableHandler(once), once);
});
