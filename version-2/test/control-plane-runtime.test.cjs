const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  HOMEPAGE_IMAGE,
  renderCaddyfile,
  renderHomepageSystemdUnit,
} = require('../infrastructure/control-plane-runtime.cjs');

test('Caddy exposes the single Home origin only through Suite Manager', () => {
  const caddyfile = renderCaddyfile();

  assert.match(caddyfile, /http:\/\/\$MOS_V2_HOME_HOST/);
  assert.doesNotMatch(caddyfile, /MOS_V2_SUITE_MANAGER_HOST/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:\$MOS_V2_SUITE_MANAGER_PORT/);
  assert.doesNotMatch(caddyfile, /3200|homepage:3000|reverse_proxy\s+homepage/);
});

test('Homepage runtime is pinned and reachable only through loopback', () => {
  const unit = renderHomepageSystemdUnit();

  assert.match(HOMEPAGE_IMAGE, /^ghcr\.io\/gethomepage\/homepage@sha256:[a-f0-9]{64}$/);
  assert.match(unit, /--publish 127\.0\.0\.1:3200:3000/);
  assert.match(unit, /HOMEPAGE_ALLOWED_HOSTS=\$MOS_V2_HOME_HOST/);
  assert.match(unit, /\/homepage\/config:\/app\/config/);
  assert.match(unit, /\/homepage\/config\/images:\/app\/public\/images/);
  assert.doesNotMatch(unit, /0\.0\.0\.0:3200|--network host/);
});

test('Homepage ships useful defaults and an editable source template without overlay account controls', () => {
  const configDir = path.join(__dirname, '..', 'infrastructure', 'homepage');
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
  assert.match(bookmarks, /discord\.gg\/K72wyWRt/);
  assert.match(bookmarks, /- Releases:/);
  assert.match(bookmarks, /- Social:/);
  assert.match(bookmarks, /- Docs:/);
  assert.match(customJavaScript, /root\.classList\.add\(desiredTheme\)/);
  assert.doesNotMatch(customJavaScript, /Sign out|createElement|mos-dashboard-toolbar/);
  assert.match(customCss, /\.bookmark-group a/);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'my-own-suite-mark.png')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'images', 'funkyton-F-icon.png')), true);
});
