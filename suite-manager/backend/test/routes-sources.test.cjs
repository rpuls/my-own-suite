const assert = require('node:assert/strict');
const test = require('node:test');

const { ExternalSourceError } = require('../src/apps/external-source-registry.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const SOURCE = { id: 'src-community', mosReviewed: false, official: false, repository: 'https://github.com/community/apps', trust: 'unverified' };
const CARD = { external: true, mosReviewed: false, packageId: 'community-notes', trust: 'unverified' };

// What the routes ask of the source service, in order. Its behaviour is
// external-source-service.test.cjs; a hostile repository answers as the gate does.
function fakeSources(calls) {
  const hostile = (repository) => String(repository).endsWith('/hostile');
  return {
    async addSource(input, options) {
      calls.push(['add', input, options]);
      if (String(input.repository).startsWith('http:')) throw new ExternalSourceError('SOURCE_URL_INVALID', 'Package sources must be HTTPS.');
      return SOURCE;
    },
    async installUrl(url, options) {
      calls.push(['install', url, options]);
      if (hostile(url)) throw new ExternalSourceError('CANDIDATE_REJECTED', 'External candidate failed validation.');
      return { instance: { packageId: 'x-abcdef01-community-notes' }, mosReviewed: false, packageId: 'x-abcdef01-community-notes', trust: 'unverified' };
    },
    listSources: () => [SOURCE],
    async previewCandidate(id, options) {
      calls.push(['preview', id, options]);
      if (id === 'src-hostile') throw new ExternalSourceError('CANDIDATE_REJECTED', 'External candidate failed validation.');
      return { mosReviewed: false, permissions: ['route:notes', 'volume:notes-data'] };
    },
    async refreshSource(id, options) { calls.push(['refresh', id, options]); return { outcome: 'unchanged' }; },
    async removeSource(id) {
      calls.push(['remove', id]);
      if (id !== SOURCE.id) throw new ExternalSourceError('SOURCE_NOT_FOUND', 'That package source is not registered.');
      return { keepsSnapshots: true, source: { ...SOURCE, status: 'removed' } };
    },
    async resolveUrl(url) {
      calls.push(['resolve', url]);
      if (url.includes('gitlab.com')) throw new ExternalSourceError('SOURCE_URL_INVALID', 'Only GitHub repositories are supported.');
      return { added: false, packages: [{ ...CARD, hostRequirements: { architectures: ['riscv64'] } }] };
    },
    setSourceStatus: (id, status, reason) => { calls.push(['status', id, status, reason]); return { ...SOURCE, status }; },
  };
}

function sourceServices(calls) {
  return { appPackages: { hostFacts: async () => ({ architecture: 'amd64' }) }, externalSourceService: fakeSources(calls) };
}

test('an owner adds, refreshes, previews, lists, and removes an external package source', async () => {
  const calls = [];
  await withRoutes(sourceServices(calls), async (call) => {
    const added = await call('POST', '/apps/sources', {
      body: { catalogPath: 'apps', initiator: 'smuggled', publisher: 'community', repository: 'https://github.com/community/apps', trust: 'unverified' },
    });
    assert.equal(added.status, 201);
    assert.deepEqual(added.json().source, SOURCE);

    assert.deepEqual((await call('GET', '/apps/sources')).json().sources, [SOURCE]);
    assert.deepEqual((await call('POST', `/apps/sources/${SOURCE.id}/refresh`)).json(), { outcome: 'unchanged' });
    assert.deepEqual((await call('POST', `/apps/sources/${SOURCE.id}/preview`)).json().candidate.permissions, ['route:notes', 'volume:notes-data']);
    const removed = await call('POST', `/apps/sources/${SOURCE.id}/remove`);
    assert.equal(removed.json().keepsSnapshots, true);
    assert.equal(removed.json().source.status, 'removed');
  });

  assert.deepEqual(calls, [
    ['add', { catalogPath: 'apps', kind: undefined, publisher: 'community', repository: 'https://github.com/community/apps', signature: undefined, trust: 'unverified' }, { ref: 'main' }],
    ['refresh', SOURCE.id, { force: true }],
    ['preview', SOURCE.id, { packageId: null }],
    ['remove', SOURCE.id],
  ]);
});

test('pasting a package URL resolves cards with what this host cannot meet', async () => {
  const calls = [];
  await withRoutes(sourceServices(calls), async (call) => {
    const resolved = await call('POST', '/apps/sources/resolve', { body: { url: 'https://github.com/community/community-notes' } });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json().added, false);
    assert.equal(resolved.json().packages[0].packageId, 'community-notes');
    assert.equal(resolved.json().packages[0].unmetRequirements.length, 1);

    const badUrl = await call('POST', '/apps/sources/resolve', { body: { url: 'https://gitlab.com/community/notes' } });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.json().code, 'SOURCE_URL_INVALID');
  });
});

test('an owner installs a pasted package URL, and a hostile candidate is refused as 422', async () => {
  const calls = [];
  await withRoutes(sourceServices(calls), async (call) => {
    const denied = await call('POST', '/apps/sources/install', { body: { url: 'https://github.com/community/community-notes' }, signedIn: false });
    assert.equal(denied.status, 401);
    assert.deepEqual(calls, []);

    const installed = await call('POST', '/apps/sources/install', {
      body: { config: { adminEmail: 'owner@example.com' }, url: 'https://github.com/community/community-notes' },
    });
    assert.equal(installed.status, 201);
    assert.equal(installed.json().instance.packageId, installed.json().packageId);

    const hostile = await call('POST', '/apps/sources/install', { body: { url: 'https://github.com/community/hostile' } });
    assert.equal(hostile.status, 422);
    assert.equal(hostile.json().code, 'CANDIDATE_REJECTED');
  });

  assert.deepEqual(calls[0], ['install', 'https://github.com/community/community-notes', { config: { adminEmail: 'owner@example.com' }, packageId: null }]);
});

test('external source routes reject a bad URL as 400, a hostile candidate as 422 and an unknown source as 404', async () => {
  const calls = [];
  await withRoutes(sourceServices(calls), async (call) => {
    const badUrl = await call('POST', '/apps/sources', { body: { repository: 'http://github.com/community/apps', trust: 'unverified' } });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.json().code, 'SOURCE_URL_INVALID');

    const hostile = await call('POST', '/apps/sources/src-hostile/preview');
    assert.equal(hostile.status, 422);
    assert.equal(hostile.json().code, 'CANDIDATE_REJECTED');

    const missing = await call('POST', '/apps/sources/src-does-not-exist/remove');
    assert.equal(missing.status, 404);
    assert.equal(missing.json().code, 'SOURCE_NOT_FOUND');
  });
});

test('a source status change carries only a string reason, and a preview tolerates a body it cannot read', async () => {
  const calls = [];
  await withRoutes(sourceServices(calls), async (call) => {
    assert.equal((await call('POST', `/apps/sources/${SOURCE.id}/status`, { body: { reason: 42, status: 'unavailable' } })).status, 200);
    assert.equal((await call('POST', `/apps/sources/${SOURCE.id}/status`, { body: { reason: 'moved', status: 'compromised' } })).status, 200);
    assert.equal((await call('POST', `/apps/sources/${SOURCE.id}/preview`, { body: '{"packageId":' })).status, 200);
  });

  assert.deepEqual(calls, [
    ['status', SOURCE.id, 'unavailable', null],
    ['status', SOURCE.id, 'compromised', 'moved'],
    ['preview', SOURCE.id, { packageId: null }],
  ]);
});

test('anything else under the sources path asks for a session before it is not found', async () => {
  await withRoutes(sourceServices([]), async (call) => {
    assert.equal((await call('GET', `/apps/sources/${SOURCE.id}/status`, { signedIn: false })).status, 401);
    assert.equal((await call('GET', `/apps/sources/${SOURCE.id}/status`)).status, 404);
    assert.equal((await call('DELETE', '/apps/sources')).status, 404);
  });
});
