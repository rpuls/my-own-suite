'use strict';

// The dashboard as an AI changes it: a model of groups and tiles, operations
// applied all or nothing, app tiles and home services kept out of reach, and
// every change kept as a checkpoint the owner can go back to.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const YAML = require('yaml');

const { Dashboard, reconcileAppTiles } = require('../src/homepage/dashboard-model.cjs');
const { HomepageService } = require('../src/homepage/homepage-service.cjs');

const APP_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';

const services = `# kept comment
- Media:
    - Jellyfin:
        href: /suite-manager/open/${APP_ID}
        description: Films
        icon: jellyfin
        mos:
          id: ${APP_ID}
          managedBy: user
    - Docs:
        href: https://example.com/docs
        description: Reading
        icon: mdi-book
        mos:
          id: ${LINK_ID}
          managedBy: user
- Home:
    - Printer:
        href: '#'
        description: Office printer
        icon: mdi-printer
        mos:
          id: ${SERVICE_ID}
          managedBy: user
          proxy:
            subdomain: printer
            upstream: http://192.168.1.20:8080
    - Lab:
        - Router:
            href: http://192.168.1.1/
            description: The router
            icon: mdi-router
`;
const settings = 'title: My Own Suite\nlayout:\n  Media:\n    style: row\n    columns: 3\n';

function dashboard() {
  return new Dashboard({ services, settings });
}

function tilesIn(content, group) {
  const value = YAML.parse(content).find((item) => item[group])[group];
  return value.map((item) => Object.keys(item)[0]);
}

test('the model names every tile by kind and hides the metadata behind it', () => {
  const model = dashboard().model();
  assert.equal(model.title, 'My Own Suite');
  const [media, home] = model.groups;
  assert.deepEqual(media.layout, { columns: 3, style: 'row' });
  assert.deepEqual(media.items.map(({ tile }) => [tile.name, tile.kind]), [['Jellyfin', 'app'], ['Docs', 'link']]);
  assert.equal(media.items[1].tile.link, 'https://example.com/docs');
  assert.equal(media.items[0].tile.link, undefined);
  assert.equal(home.items[0].tile.kind, 'home-service');
  assert.equal(home.items[1].group.name, 'Lab');
  assert.doesNotMatch(JSON.stringify(model), /mos|proxy|upstream/u);
});

test('a batch moves, edits, adds and lays out in one change, keeping comments', () => {
  const next = dashboard().apply([
    { op: 'add_group', name: 'Watch' },
    { op: 'move', tile: 'Jellyfin', to: 'Watch' },
    { op: 'edit', icon: 'mdi-movie', name: 'Films', tile: 'Jellyfin' },
    { link: 'https://example.org/', name: 'News', op: 'add_link', description: 'Daily', to: 'Home > Lab', position: 0 },
    { op: 'rename_group', group: 'Media', name: 'Reading' },
    { columns: 2, group: 'Watch', op: 'set_layout', style: 'column' },
  ]);
  assert.match(next.services, /# kept comment/u);
  assert.deepEqual(tilesIn(next.services, 'Watch'), ['Films']);
  assert.deepEqual(tilesIn(next.services, 'Reading'), ['Docs']);
  assert.match(next.services, new RegExp(`/suite-manager/open/${APP_ID}`, 'u'), 'an app tile keeps its managed address');
  const layout = YAML.parse(next.settings).layout;
  assert.deepEqual(layout.Reading, { columns: 3, style: 'row' }, 'renaming a group carries its layout');
  assert.deepEqual(layout.Watch, { columns: 2, style: 'column' });
  assert.equal(next.summary.length, 6);
});

test('app tiles and home services can be moved but not removed or re-pointed', () => {
  assert.throws(() => dashboard().apply([{ op: 'remove_link', tile: 'Jellyfin' }]), /belongs to an installed app/u);
  assert.throws(() => dashboard().apply([{ op: 'remove_link', tile: 'Printer' }]), /home service/u);
  assert.throws(() => dashboard().apply([{ link: 'https://evil.example/', op: 'edit', tile: 'Printer' }]), /managed by MOS/u);
  assert.doesNotThrow(() => dashboard().apply([{ op: 'move', tile: 'Printer', to: 'Media', position: 0 }]));
});

test('one bad operation changes nothing and says which one failed', () => {
  const board = dashboard();
  assert.throws(() => board.apply([{ op: 'move', tile: 'Docs', to: 'Home' }, { op: 'remove_group', group: 'Home' }]), /Operation 2 \(remove_group\): "Home" is not empty/u);
  assert.throws(() => dashboard().apply([{ name: 'Deep', op: 'add_group', parent: 'Home > Lab' }]), /one level deep/u);
  assert.throws(() => dashboard().apply([{ op: 'add_link', name: 'X', link: 'javascript:alert(1)', description: 'x', to: 'Media' }]), /http or https/u);
  assert.throws(() => dashboard().apply([{ op: 'shuffle' }]), /no known "op"/u);
});

test('a restore drops tiles of apps uninstalled since and keeps tiles of apps installed since', () => {
  const NEW_APP = '44444444-4444-4444-8444-444444444444';
  const current = `${services}- Notes:
    - Memos:
        href: /suite-manager/open/${NEW_APP}
        description: Notes
        icon: memos
        mos:
          id: ${NEW_APP}
          managedBy: user
`;
  const restored = reconcileAppTiles({ current, installedIds: new Set([NEW_APP]), restored: services });
  assert.doesNotMatch(restored, new RegExp(APP_ID, 'u'), 'Jellyfin is no longer installed');
  assert.match(restored, new RegExp(NEW_APP, 'u'), 'Memos was installed after the checkpoint');
  assert.match(restored, /Docs/u);
});

function fakeAgent(files) {
  const revision = (content) => `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  return {
    files,
    async applyFiles({ files: changes }) {
      for (const change of changes) {
        if (revision(files[change.file]) !== change.expectedRevision) throw Object.assign(new Error('conflict'), { code: 'HOMEPAGE_REVISION_CONFLICT', statusCode: 409 });
      }
      for (const change of changes) files[change.file] = change.content;
      return { changed: true, revisions: Object.fromEntries(changes.map((change) => [change.file, revision(change.content)])), steps: ['written'] };
    },
    async read(file) { return { content: files[file], file, revision: revision(files[file]) }; },
    async validate() { return { valid: true }; },
  };
}

function fakeStore() {
  const rows = [];
  let next = 1;
  return {
    addHomepageCheckpoint({ actor, at, digest, files, keep, summary }) {
      rows.push({ actor, at, digest, files, id: next++, summary });
      while (rows.length > keep) rows.shift();
    },
    completeHomepageOperation() {},
    deleteHomepageCheckpoint(id) { rows.splice(rows.findIndex((row) => row.id === id), 1); },
    deleteHomepageCheckpointsBefore(id) { for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index].id < id) rows.splice(index, 1); },
    failHomepageOperation() {},
    homepageCheckpoint(id) { return rows.find((row) => row.id === id) || null; },
    homepageCheckpoints() { return [...rows].reverse().map(({ actor, at, id, summary }) => ({ actor, at, id, summary })); },
    latestHomepageCheckpoint() { return rows.at(-1) || null; },
    recordHomepageRevision() {},
    rows,
    startHomepageOperation() {},
  };
}

function service(files = {}) {
  const agent = fakeAgent({ 'bookmarks.yaml': '[]\n', 'services.template.yaml': services, 'settings.yaml': settings, 'widgets.yaml': '[]\n', ...files });
  const store = fakeStore();
  const homepage = new HomepageService({
    agent,
    installedAppIds: () => new Set([APP_ID]),
    store,
    suiteAddress: { read: () => ({ hostname: 'mos.example.com', scheme: 'https' }) },
  });
  return { agent, homepage, store };
}

test('every change is a checkpoint, the first keeps what came before, and going back is undoable', async () => {
  const { agent, homepage, store } = service();
  const result = await homepage.changeDashboard({ actor: 'LM Studio', operations: [{ op: 'move', tile: 'Docs', to: 'Home' }] });
  assert.equal(result.applied, true);
  assert.deepEqual(store.rows.map((row) => [row.actor, row.summary]), [['MOS', 'How your dashboard was before'], ['LM Studio', 'Moved Docs to Home']]);

  const preview = await homepage.changeDashboard({ actor: 'LM Studio', operations: [{ op: 'remove_link', tile: 'Docs' }], preview: true });
  assert.equal(preview.applied, false);
  assert.equal(store.rows.length, 2, 'a preview saves nothing');

  await homepage.restore(store.rows[0].id);
  assert.equal(agent.files['services.template.yaml'], services);
  assert.equal(store.rows.at(-1).summary, 'Went back to an earlier version');
  assert.equal(homepage.history().checkpoints[0].current, true);
});

test('the current version cannot be deleted, and keeping only it clears the rest', async () => {
  const { homepage, store } = service();
  await homepage.changeDashboard({ actor: 'You', operations: [{ op: 'set_title', title: 'Home' }] });
  assert.throws(() => homepage.deleteCheckpoint(store.rows.at(-1).id), /how your dashboard is now/u);
  homepage.keepOnlyCurrent();
  assert.equal(store.rows.length, 1);
});

test('only twenty versions are kept', async () => {
  const { store, homepage } = service();
  for (let index = 0; index < 25; index += 1) await homepage.changeDashboard({ actor: 'You', operations: [{ op: 'set_title', title: `Home ${index}` }] });
  assert.equal(store.rows.length, 20);
  assert.equal(store.rows.at(-1).summary, 'Set the title to Home 24');
});

test('going back to a version with a home service the dashboard no longer has waits for the owner', async () => {
  const { homepage, store } = service();
  await homepage.changeDashboard({ actor: 'You', operations: [{ op: 'set_title', title: 'Before' }] });
  const withoutPrinter = services.replace(/    - Printer:[\s\S]*?upstream: http:\/\/192\.168\.1\.20:8080\n/u, '');
  homepage.agent.files['services.template.yaml'] = withoutPrinter;
  await assert.rejects(() => homepage.restore(store.rows[0].id), (error) => error.code === 'HOMEPAGE_RESTORE_OPENS_ADDRESSES' && /printer/u.test(error.message));
  await homepage.restore(store.rows[0].id, { confirmAddresses: true });
  assert.match(homepage.agent.files['services.template.yaml'], /Printer/u);
});
