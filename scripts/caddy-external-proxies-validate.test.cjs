const assert = require('node:assert/strict');
const test = require('node:test');

const { validateGeneratedExternalProxySnippet } = require('./caddy-external-proxies-validate.cjs');

test('accepts empty and comment-only generated external proxy snippets', () => {
  const result = validateGeneratedExternalProxySnippet(`# Generated external proxy routes.
#
# No generated external proxy routes.
`);

  assert.equal(result.valid, true);
  assert.deepEqual(result.routes, []);
  assert.deepEqual(result.errors, []);
});

test('accepts generated external proxy routes including HTTPS upstream TLS skip', () => {
  const result = validateGeneratedExternalProxySnippet(`homeassistant.home.example.com {
\treverse_proxy http://192.168.30.4:8123
}

truenas.home.example.com {
\treverse_proxy https://192.168.30.3 {
\t\ttransport http {
\t\t\ttls_insecure_skip_verify
\t\t}
\t}
}
`);

  assert.equal(result.valid, true);
  assert.deepEqual(result.routes, [
    {
      host: 'homeassistant.home.example.com',
      siteAddress: 'homeassistant.home.example.com',
      tlsInsecureSkipVerify: false,
      upstream: 'http://192.168.30.4:8123',
    },
    {
      host: 'truenas.home.example.com',
      siteAddress: 'truenas.home.example.com',
      tlsInsecureSkipVerify: true,
      upstream: 'https://192.168.30.3',
    },
  ]);
});

test('rejects malformed snippets before they can silently break Caddy startup', () => {
  const result = validateGeneratedExternalProxySnippet(`broken.home.example.com {
\treverse_proxy http://192.168.30.4:8123
`);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message || '', /closing brace/i);
});

test('rejects origin paths in generated reverse proxy upstreams', () => {
  const result = validateGeneratedExternalProxySnippet(`service.home.example.com {
\treverse_proxy http://192.168.30.4:8123/app
}
`);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message || '', /origin-only/i);
});

test('rejects raw or manual Caddy directives in generated snippet', () => {
  const result = validateGeneratedExternalProxySnippet(`service.home.example.com {
\theader X-Test "manual"
\treverse_proxy http://192.168.30.4:8123
}
`);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message || '', /reverse_proxy/i);
});

test('rejects duplicate generated route hosts', () => {
  const result = validateGeneratedExternalProxySnippet(`service.home.example.com {
\treverse_proxy http://192.168.30.4:8123
}

service.home.example.com {
\treverse_proxy http://192.168.30.5:8123
}
`);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message || '', /Duplicate generated external proxy host/i);
});
