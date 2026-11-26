'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AttentionService, GRACE_MS } = require('../src/attention/attention-service.cjs');
const { summarizeTrouble } = require('../src/diagnostics/support-bundle.cjs');

const DAY = 86_400_000;

function harness({ backups, clients = [], down = [], instances, sources = [], storage = [], tokens = {}, tunnel = null, updates } = {}) {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const service = new AttentionService({
    aiConnections: {
      aiStore: { listClients: () => clients },
      catalog: { sources: () => sources, tokenOf: (source) => tokens[source.id] || null },
    },
    appPackages: { containersDown: async () => (id) => down.includes(id) },
    backupAgent: { status: async () => backups ?? { backups: [{ createdAt: '2026-11-22T03:00:00Z', owner: 'this' }], places: [{ id: 'nas' }], schedule: { enabled: true, nextRunAt: '2026-11-23T03:00:00Z', timeZone: 'Europe/Amsterdam' } } },
    chatGptTunnel: { status: async () => tunnel },
    installJobs: { get: () => null },
    now: () => new Date(clock),
    storage: { inventory: async () => ({ storage }) },
    store: { getAppInstances: () => instances ?? [
      { displayNameSnapshot: 'Memos', enabled: true, packageId: 'memos', status: 'installed' },
      { displayNameSnapshot: 'Paperless-ngx', enabled: true, packageId: 'paperless-ngx', status: 'installed' },
    ] },
    updateJobs: { get: () => null },
    updates: { status: async () => updates ?? { checkedAt: '2026-11-22T06:00:00Z', host: { rebootRequired: false }, serviceAvailable: true, updateAvailable: false } },
  });
  return { later: (ms) => { clock += ms; }, service };
}

test('a stopped app is held back until it has stayed stopped past the grace period', async () => {
  const h = harness({ down: ['paperless-ngx'] });
  assert.deepEqual((await h.service.overview()).apps.issues, []);
  h.later(GRACE_MS);
  const { apps } = await h.service.overview();
  assert.deepEqual(apps.issues.map((issue) => [issue.text, issue.detail, issue.app, issue.since]), [['Paperless-ngx stopped', 'and did not start again.', 'paperless-ngx', '2026-11-22T12:00:00.000Z']]);
  assert.deepEqual([apps.running, apps.total], [1, 2]);
});

test('an app that recovers within the grace period is never reported, and its clock starts over', async () => {
  const h = harness({ down: ['memos'] });
  await h.service.issues();
  h.later(GRACE_MS / 2);
  h.service.appPackages.containersDown = async () => () => false;
  await h.service.issues();
  h.service.appPackages.containersDown = async () => (id) => id === 'memos';
  h.later(GRACE_MS / 2);
  assert.deepEqual(await h.service.issues(), []);
});

test('a failed install and an app waiting for its setup are reported at once', async () => {
  const h = harness({ instances: [
    { displayNameSnapshot: 'Immich', enabled: true, packageId: 'immich', status: 'failed' },
    { displayNameSnapshot: 'Seafile', enabled: true, packageId: 'seafile', status: 'needs-config' },
  ] });
  assert.deepEqual((await h.service.issues()).map((issue) => issue.text), ['Immich did not finish installing', 'Seafile needs to be set up']);
});

test('a drive an app keeps its files on names both, and a drive holding only backups goes to the storage tile', async () => {
  const h = harness({ storage: [
    { apps: ['paperless-ngx'], id: 'wd', kind: 'drive', name: 'WD passport', state: 'away' },
    { apps: [], backups: { ours: true }, connected: true, id: 'nas', kind: 'share', name: 'backup_mos', state: 'unreachable' },
    { apps: [], availableBytes: 400e9, connected: true, id: 'system', kind: 'system', name: 'System drive', state: 'ready' },
  ] });
  h.later(GRACE_MS);
  await h.service.issues();
  h.later(GRACE_MS);
  const overview = await h.service.overview();
  assert.deepEqual(overview.apps.issues.map((issue) => `${issue.text} ${issue.detail}`), ['Paperless-ngx cannot open its files because WD passport is not connected.']);
  assert.deepEqual(overview.storage.issues.map((issue) => `${issue.text} ${issue.detail}`), ['backup_mos cannot be reached so no backup can be written to it.']);
  assert.deepEqual([overview.storage.places, overview.storage.systemFreeBytes], [1, 400e9]);
});

test('a refused ChatGPT tunnel and an app with no token are named under AI assistants', async () => {
  const clients = [
    { enabled: true, id: 'cg', lastUsedAt: '2026-11-20T13:48:00Z', levels: { memos: 'act' }, name: 'ChatGPT' },
    { enabled: true, id: 'cc', lastUsedAt: '2026-11-22T11:00:00Z', levels: {}, name: 'Claude Code' },
  ];
  const sources = [{ id: 'memos', instance: {}, mcp: {}, name: 'Memos' }, { id: 'paperless-ngx', instance: {}, mcp: { packageSecret: 'aiKey' }, name: 'Paperless-ngx' }];
  const h = harness({ clients, sources, tunnel: { clientId: 'cg', state: 'refused' } });
  await h.service.issues();
  h.later(GRACE_MS);
  const { ai } = await h.service.overview();
  assert.deepEqual(ai.issues.map((issue) => issue.text), ['ChatGPT cannot reach your suite', 'Memos needs a token']);
  assert.equal(ai.issues[0].assistant, 'ChatGPT');
  assert.deepEqual([ai.connected, ai.lastUsed], [2, { at: '2026-11-22T11:00:00Z', by: 'Claude Code' }]);
});

test('a restart Ubuntu asked for and a failed update are reported, and an available update is a number, not a problem', async () => {
  const h = harness({ updates: { currentJob: { id: 'job-1', status: 'failed' }, host: { rebootRequired: true }, latestRelease: { version: 'v0.24.0' }, serviceAvailable: true, updateAvailable: true } });
  const { updates } = await h.service.overview();
  assert.deepEqual(updates.issues.map((issue) => issue.text), ['A restart finishes a security update', 'The last update did not finish']);
  assert.equal(updates.available, 'v0.24.0');
});

test('a failed automatic backup, an old backup and no backup at all are each reported', async () => {
  const failed = harness({ backups: { backups: [], places: [{}], schedule: { lastResult: { message: 'The drive was full.', status: 'failed' } } } });
  assert.deepEqual((await failed.service.issues()).map((issue) => `${issue.text}: ${issue.detail}`), ['The last automatic backup did not finish: The drive was full.']);

  const old = harness({ backups: { backups: [{ createdAt: new Date(Date.parse('2026-11-22T12:00:00Z') - 5 * DAY).toISOString(), owner: 'this' }], places: [{}], schedule: {} } });
  assert.deepEqual((await old.service.issues()).map((issue) => issue.text), ['The last backup was 5 days ago']);

  const none = harness({ backups: { backups: [{ createdAt: '2026-11-22T03:00:00Z', owner: 'other' }], places: [{}], schedule: {} } });
  assert.deepEqual((await none.service.issues()).map((issue) => issue.text), ['No backups of this server yet']);
});

test('a source that cannot answer leaves its own tile unknown and the rest intact', async () => {
  const h = harness();
  h.service.updates.status = async () => { throw new Error('update agent is down'); };
  h.service.backupAgent.status = async () => { throw new Error('backup agent is down'); };
  const overview = await h.service.overview();
  assert.equal(overview.updates, null);
  assert.equal(overview.backups, null);
  assert.deepEqual([overview.apps.running, overview.apps.total], [2, 2]);
});

test('a refused tunnel says nothing while ChatGPT is turned off', async () => {
  const h = harness({ clients: [{ enabled: false, id: 'cg', lastUsedAt: null, levels: {}, name: 'ChatGPT' }], tunnel: { clientId: 'cg', state: 'refused' } });
  await h.service.issues();
  h.later(GRACE_MS);
  const { ai } = await h.service.overview();
  assert.deepEqual([ai.issues, ai.connected], [[], 0]);
});

test('the diagnostics summary adds only the problems it does not already report in its own words', () => {
  const trouble = summarizeTrouble({ attention: [
    { detail: 'Remove it and add it again in Settings.', inDiagnostics: true, text: 'ChatGPT cannot reach your suite' },
    { detail: 'and did not start again.', inDiagnostics: false, text: 'Memos stopped' },
  ] });
  assert.deepEqual(trouble, ['ChatGPT cannot reach your suite. Remove it and add it again in Settings.']);
});

test('a lowercase detail finishes the issue text, and an issue without one is its text alone', () => {
  const trouble = summarizeTrouble({ attention: [
    { detail: 'and did not start again.', inDiagnostics: true, text: 'Memos stopped' },
    { detail: null, inDiagnostics: true, text: 'The backup did not run.' },
  ] });
  assert.deepEqual(trouble, ['Memos stopped and did not start again.', 'The backup did not run.']);
});
