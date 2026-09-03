'use strict';

// The ${smtp.*} runtime namespace: how a stored relay becomes environment on the
// apps that ask for it, and — the property that makes this change safe to ship —
// how it changes nothing for the apps that do not.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  materializeRuntimeCompose,
  renderDryRunProjections,
  resolveConfigTemplate,
} = require('../src/apps/app-package-internals.cjs');
const { readStoredRelay, smtpTemplateValues } = require('../src/settings/smtp-relay.cjs');
const { SMTP_TEMPLATE_KEYS } = require('../../../shared/smtp-contract.cjs');

const relay = {
  allowInvalidCert: true,
  fromAddress: 'noreply@example.com',
  fromName: 'My Suite',
  host: 'smtp.example.com',
  password: 'relay-secret-value',
  port: 587,
  security: 'starttls',
  username: 'relay-user',
};

test('smtpTemplateValues exposes exactly the contract keys, as strings', () => {
  const map = smtpTemplateValues(relay);
  assert.deepEqual([...map.keys()].sort(), [...SMTP_TEMPLATE_KEYS].sort());
  assert.equal(map.get('configured'), 'true');
  assert.equal(map.get('allowInvalidCert'), 'true');
  assert.equal(map.get('port'), '587');
  assert.equal(map.get('host'), 'smtp.example.com');
  assert.equal(map.get('password'), 'relay-secret-value');
});

test('with no relay, every value is empty and configured is false — never the literal reference', () => {
  const map = smtpTemplateValues(null);
  assert.deepEqual([...map.keys()].sort(), [...SMTP_TEMPLATE_KEYS].sort());
  assert.equal(map.get('configured'), 'false');
  assert.equal(map.get('host'), '');
  assert.equal(map.get('startTls'), 'false');
  assert.equal(map.get('implicitTls'), 'false');
  // An app wired to ${smtp.host} sees an empty host, so its own mailer stays off.
  assert.equal(resolveConfigTemplate('${smtp.host}', [], { smtp: map }), '');
  assert.equal(resolveConfigTemplate('${smtp.configured}', [], { smtp: map }), 'false');
});

test('the encryption choice is offered as both a word and two booleans', () => {
  const bools = (security) => {
    const map = smtpTemplateValues({ ...relay, security });
    return { implicitTls: map.get('implicitTls'), security: map.get('security'), startTls: map.get('startTls') };
  };
  assert.deepEqual(bools('starttls'), { implicitTls: 'false', security: 'starttls', startTls: 'true' });
  assert.deepEqual(bools('tls'), { implicitTls: 'true', security: 'tls', startTls: 'false' });
  assert.deepEqual(bools('none'), { implicitTls: 'false', security: 'none', startTls: 'false' });
});

test('a reference resolves from the map, and stays literal when there is no relay', () => {
  assert.equal(resolveConfigTemplate('${smtp.host}:${smtp.port}', [], { smtp: smtpTemplateValues(relay) }), 'smtp.example.com:587');
  assert.equal(resolveConfigTemplate('${smtp.host}', [], {}), '${smtp.host}');
  assert.equal(resolveConfigTemplate('${smtp.host}', [], { smtp: null }), '${smtp.host}');
  // An unknown key is left untouched rather than blanked.
  assert.equal(resolveConfigTemplate('${smtp.unknown}', [], { smtp: smtpTemplateValues(relay) }), '${smtp.unknown}');
});

test('materialize resolves ${smtp.*} per service and leaves shell ${VAR} alone', () => {
  const compose = { services: [{ id: 'web', environment: {
    MAIL_FROM: '${smtp.fromAddress}',
    MAIL_HOST: '${smtp.host}',
    MAIL_PASS: '${smtp.password}',
    MAIL_PORT: '${smtp.port}',
    SHELL_STYLE: 'keep ${HOME} and ${PATH}',
  } }] };
  const out = materializeRuntimeCompose(compose, [], [], { smtp: smtpTemplateValues(relay) });
  assert.deepEqual(out.services[0].environment, {
    MAIL_FROM: 'noreply@example.com',
    MAIL_HOST: 'smtp.example.com',
    MAIL_PASS: 'relay-secret-value',
    MAIL_PORT: '587',
    SHELL_STYLE: 'keep ${HOME} and ${PATH}',
  });
});

// The reason this whole change is additive: an app that never references the
// namespace materializes to exactly the same bytes whether or not a relay is
// configured. Every already-installed app is in this set.
test('an app that does not reference the relay is byte-identical with or without one', () => {
  const compose = { services: [{ id: 'web', environment: { FOO: 'bar', URL: 'http://x', SHELL: 'literal ${HOME}' } }] };
  const withRelay = materializeRuntimeCompose(compose, [], [], { smtp: smtpTemplateValues(relay) });
  const without = materializeRuntimeCompose(compose, [], []);
  assert.deepEqual(withRelay, without);
});

// The relay is resolved only at materialize time, so the stored projection keeps
// the reference and the digest never depends on the relay host or password.
// Changing the relay therefore cannot make an installed app look out of date.
test('the stored projection keeps ${smtp.*} literal, so the digest is relay-independent', () => {
  const manifest = {
    health: { type: 'http', url: 'http://web:8080/health' },
    id: 'mailer-app',
    resources: { services: { web: { dockerfile: 'Dockerfile', env: { MAIL_HOST: '${smtp.host}', MAIL_PASS: '${smtp.password}' }, internalPort: 8080, volumes: [] } } },
    routes: [{ host: 'mailer-app', service: 'web' }],
  };
  const projections = renderDryRunProjections(manifest, []);
  const compose = projections.find((projection) => projection.kind === 'compose');
  assert.equal(compose.content.services[0].environment.MAIL_HOST, '${smtp.host}');
  assert.equal(compose.content.services[0].environment.MAIL_PASS, '${smtp.password}');
  assert.ok(!compose.contentJson.includes('smtp.example.com'), 'no relay value is baked into the stored projection');
});

test('readStoredRelay reports unconfigured, then the relay with its password read on demand', () => {
  const empty = { getSmtpSettings: () => ({ host: null }) };
  assert.deepEqual(readStoredRelay(empty, () => 'unused'), { configured: false, relay: null, settings: { host: null } });

  const configured = {
    getSmtpSettings: () => ({
      allowInvalidCert: 1,
      fromAddress: 'noreply@example.com',
      fromName: 'My Suite',
      host: 'smtp.example.com',
      passwordRef: '/secrets/_settings/smtp-password.secret',
      port: 587,
      security: 'starttls',
      username: 'relay-user',
    }),
  };
  const reads = [];
  const result = readStoredRelay(configured, (ref) => { reads.push(ref); return 'the-password'; });
  assert.equal(result.configured, true);
  assert.equal(result.relay.password, 'the-password');
  assert.equal(result.relay.allowInvalidCert, true);
  assert.deepEqual(reads, ['/secrets/_settings/smtp-password.secret']);
});
