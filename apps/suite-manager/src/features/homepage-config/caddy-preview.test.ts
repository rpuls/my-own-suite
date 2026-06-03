import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaddyProxyPreviewFromServicesTemplate } from './caddy-preview.ts';

test('generates preview routes for nested external proxy annotations', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- My Shortcuts:
    - Home Lab:
        - Home Assistant:
            href: https://homeassistant.home.example.com
            description: Smart home control
            mos:
              kind: external
              proxy:
                enabled: true
                upstream: http://192.168.30.4:8123
`);

  assert.equal(preview.valid, true);
  assert.equal(preview.errors.length, 0);
  assert.deepEqual(preview.routes, [
    {
      host: 'homeassistant.home.example.com',
      href: 'https://homeassistant.home.example.com/',
      path: 'My Shortcuts > Home Lab > Home Assistant',
      siteAddress: 'homeassistant.home.example.com',
      title: 'Home Assistant',
      upstream: 'http://192.168.30.4:8123',
      upstreamTlsInsecureSkipVerify: false,
    },
  ]);
  assert.equal(
    preview.caddyfile,
    'homeassistant.home.example.com {\n\treverse_proxy http://192.168.30.4:8123\n}\n',
  );
});

test('generates explicit HTTP site addresses for HTTP dashboard URLs', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Appliances:
    - TrueNAS:
        href: http://truenas.mos.home
        mos:
          proxy:
            enabled: true
            upstream: http://192.168.30.3:81
`);

  assert.equal(preview.valid, true);
  assert.equal(preview.routes[0]?.siteAddress, 'http://truenas.mos.home');
  assert.equal(
    preview.caddyfile,
    'http://truenas.mos.home {\n\treverse_proxy http://192.168.30.3:81\n}\n',
  );
});

test('uses app-subdomain metadata for managed public route protocol and domain', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(
    `
- Appliances:
    - Home Assistant:
        href: http://homeassistant.mos.home
        mos:
          public:
            mode: app-subdomain
            subdomain: homeassistant
          proxy:
            enabled: true
            upstream: http://192.168.30.4:8123
`,
    { domain: 'home.example.com', urlScheme: 'https' },
  );

  assert.equal(preview.valid, true);
  assert.equal(preview.routes[0]?.host, 'homeassistant.home.example.com');
  assert.equal(preview.routes[0]?.href, 'https://homeassistant.home.example.com/');
  assert.equal(preview.routes[0]?.siteAddress, 'homeassistant.home.example.com');
  assert.equal(
    preview.caddyfile,
    'homeassistant.home.example.com {\n\treverse_proxy http://192.168.30.4:8123\n}\n',
  );
});

test('generates TLS skip transport only for HTTPS upstreams', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Appliances:
    - TrueNAS:
        href: https://truenas.home.example.com
        mos:
          proxy:
            enabled: true
            upstream: https://192.168.30.3
            tls:
              insecureSkipVerify: true
`);

  assert.equal(preview.valid, true);
  assert.equal(
    preview.caddyfile,
    [
      'truenas.home.example.com {',
      '\treverse_proxy https://192.168.30.3 {',
      '\t\ttransport http {',
      '\t\t\ttls_insecure_skip_verify',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
});

test('ignores tiles without enabled proxy annotations', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Bookmarks:
    - Example:
        href: https://example.com
    - Disabled:
        href: https://disabled.example.com
        mos:
          proxy:
            enabled: false
            upstream: http://192.168.1.10:8080
`);

  assert.equal(preview.valid, true);
  assert.deepEqual(preview.routes, []);
  assert.equal(preview.caddyfile, '');
});

test('reports invalid href and upstream URLs without generating config', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Broken:
    - Bad Tile:
        href: ftp://bad.example.com
        mos:
          proxy:
            enabled: true
            upstream: not-a-url
`);

  assert.equal(preview.valid, false);
  assert.equal(preview.caddyfile, '');
  assert.deepEqual(
    preview.errors.map((error) => error.message),
    [
      '`href` must be an absolute http or https URL with a non-wildcard hostname.',
      '`mos.proxy.upstream` must be an absolute http or https URL with a non-wildcard hostname.',
    ],
  );
});

test('rejects upstream URLs with paths before generating Caddy config', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Broken:
    - Path Upstream:
        href: https://path-upstream.home.example.com
        mos:
          proxy:
            enabled: true
            upstream: http://192.168.1.10:8080/app
`);

  assert.equal(preview.valid, false);
  assert.equal(preview.caddyfile, '');
  assert.equal(preview.routes.length, 0);
  assert.deepEqual(
    preview.errors.map((error) => error.message),
    ['`mos.proxy.upstream` must not include a path, query string, or fragment.'],
  );
});

test('rejects duplicate proxy hostnames', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Group:
    - First:
        href: https://service.home.example.com
        mos:
          proxy:
            enabled: true
            upstream: http://192.168.1.10
    - Second:
        href: https://SERVICE.home.example.com
        mos:
          proxy:
            enabled: true
            upstream: http://192.168.1.11
`);

  assert.equal(preview.valid, false);
  assert.equal(preview.caddyfile, '');
  assert.equal(preview.routes.length, 0);
  assert.match(preview.errors[0]?.message || '', /Duplicate proxy hostname/);
});

test('rejects raw Caddy fields inside proxy annotations', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Group:
    - Unsafe:
        href: https://unsafe.home.example.com
        mos:
          proxy:
            enabled: true
            upstream: http://192.168.1.10
            caddySnippet: respond "nope"
`);

  assert.equal(preview.valid, false);
  assert.equal(preview.caddyfile, '');
  assert.match(preview.errors[0]?.message || '', /Raw Caddy fields/);
});

test('reports malformed services template YAML', () => {
  const preview = createCaddyProxyPreviewFromServicesTemplate(`
- Broken:
    - Tile:
      href: https://bad.example.com
        mos:
`);

  assert.equal(preview.valid, false);
  assert.equal(preview.caddyfile, '');
  assert.equal(preview.routes.length, 0);
  assert.match(preview.errors[0]?.message || '', /Invalid YAML/);
});
