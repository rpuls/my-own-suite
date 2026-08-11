// The contract between Suite Manager and the app agent about an app's host.
//
// These two sides are developed and tested apart: Suite Manager's tests inject a
// stub agent, and the agent's tests hand-write their own requests. Nothing else
// runs a request Suite Manager really produced through the validation the agent
// really applies, so the two were free to disagree — and did. Suite Manager built
// appHost from the package id while the agent required it to start with the route
// host, which agreed only because every official package names its route host
// after its id. Every external package, whose id is namespaced (`x-<hash>-<id>`)
// and so can never equal its route host, was rejected at apply with
// "appHost is invalid" after installing successfully.
//
// This test exists to make that class of drift fail here rather than on a host.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appPublicIdentity,
  renderDryRunProjections,
} = require('../../suite-manager/backend/src/apps/app-package-internals.cjs');
const { AppAgentCore } = require('../../system-agents/apps/agent-core.cjs');

const BASE_HOST = 'mos.home';

const manifest = {
  category: 'office',
  health: { type: 'http', url: 'http://notes:8080/healthz' },
  id: 'community-notes',
  minimumMosVersion: '0.1.0',
  name: 'Community Notes',
  resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
  routes: [{ host: 'notes', port: 8080, service: 'notes' }],
  setup: { fields: [] },
  summary: 'Notes.',
  version: '1.0.0',
};

// An agent whose adapter records what it was asked to do instead of doing it.
// The validation under test runs before the adapter is reached.
function recordingAgent() {
  const applied = [];
  const core = new AppAgentCore({
    applyAppServices: async (input) => {
      applied.push(input);
      return { services: [] };
    },
  });
  return { applied, core };
}

function runtimeRequest(packageId, projections, appHost, publicUrl) {
  const content = (kind) => projections.find((projection) => projection.kind === kind).content;
  return {
    appHost,
    caddy: content('caddy'),
    compose: content('compose'),
    health: content('health'),
    instanceId: '0d027943-c5c6-4d1c-aef7-c15fcf8c200c',
    packageDigest: `sha256:${'a'.repeat(64)}`,
    packageId,
    packageVersion: '1.0.0',
    publicUrl,
    sourceRevision: 'e'.repeat(40),
  };
}

// Exactly what applyPackageRuntime does: render the projections, then derive the
// public identity from them rather than from the package id.
function applyInput(packageId) {
  const projections = renderDryRunProjections(manifest, [], { packageId });
  const { appHost, publicUrl } = appPublicIdentity(projections, { baseHost: BASE_HOST, scheme: 'http' });
  return { projections, request: runtimeRequest(packageId, projections, appHost, publicUrl) };
}

test('the app agent accepts the runtime request Suite Manager builds for an official package', async () => {
  const { applied, core } = recordingAgent();
  const { request } = applyInput('community-notes');

  // The route host, not the id. This manifest deliberately gives them different
  // values, which every official package in this repo avoids by naming its route
  // host after its id — the coincidence that hid the id-based derivation for as
  // long as external packages did not exist.
  assert.equal(request.appHost, 'notes.mos.home');
  await core.apply(request);
  assert.equal(applied.length, 1);
  assert.match(applied[0].caddyRoutes, /^http:\/\/notes\.mos\.home \{/u);
});

test('every official package still names its route host after its id, so its address is unchanged', () => {
  // The derivation moved from the package id to the route host. That is a no-op
  // for official packages only while these agree; if a future official package
  // breaks the convention, its public address silently moves, so say so here.
  // paperless-ngx is the one deliberate divergence: the id carries the upstream
  // project name, while owners reach it at paperless.<domain> because "ngx" means
  // nothing to the person typing the address.
  const hostDiffersFromId = new Map([['paperless-ngx', 'paperless']]);
  const { discoverAppPackages } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
  const packages = discoverAppPackages(require('node:path').resolve(__dirname, '..', '..', 'apps'));
  assert.ok(packages.length > 0, 'expected official packages to be discovered');
  for (const { manifest: official } of packages) {
    const expected = hostDiffersFromId.get(official.id) ?? official.id;
    assert.equal(official.routes[0].host, expected, `official package ${official.id} must serve ${expected} as its primary route host`);
  }
});

test('the app agent accepts the runtime request Suite Manager builds for an external package', async () => {
  const { applied, core } = recordingAgent();
  const { request } = applyInput('x-abcdef01-community-notes');

  // The address is the route host under the reserved external prefix — never the
  // namespaced package id, which is an internal identity and not a name anything
  // answers on.
  assert.equal(request.appHost, 'ext-notes.mos.home');
  assert.equal(request.publicUrl, 'http://ext-notes.mos.home/');
  await core.apply(request);
  assert.equal(applied.length, 1);
  assert.match(applied[0].caddyRoutes, /^http:\/\/ext-notes\.mos\.home \{/u);
});

test('the app agent rejects an appHost derived from a namespaced package id', async () => {
  const { core } = recordingAgent();
  const packageId = 'x-abcdef01-community-notes';
  const { projections } = applyInput(packageId);
  // The derivation this contract used to use, kept as the regression it caused:
  // `${packageId}.${baseHost}`, which the agent refuses because it does not name
  // the site the agent renders.
  const appHost = `${packageId}.${BASE_HOST}`;

  await assert.rejects(
    () => core.apply(runtimeRequest(packageId, projections, appHost, `http://${appHost}/`)),
    (error) => error.code === 'INVALID_APP_RUNTIME_REQUEST' && /appHost is invalid/u.test(error.message),
  );
});

test('an external package cannot be projected onto an official app host', () => {
  const officialProjections = renderDryRunProjections(manifest, [], { packageId: 'community-notes' });
  const externalProjections = renderDryRunProjections(manifest, [], { packageId: 'x-abcdef01-community-notes' });
  const hostOf = (projections) => projections.find((projection) => projection.kind === 'caddy').content.routes[0].host;

  // Same manifest, same requested route host: the id it was installed under is
  // what decides the address, so the external copy cannot land on the official one.
  assert.equal(hostOf(officialProjections), 'notes');
  assert.equal(hostOf(externalProjections), 'ext-notes');
});
