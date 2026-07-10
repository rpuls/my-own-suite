const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HomepageConfigError,
  addEntry,
  projectServices,
  publicUrlFor,
  reconcileManagedUrls,
  removeEntryById,
  renderCaddyRoutes,
  revisionFor,
  validateYaml,
} = require('../../shared/homepage-contract.cjs');
const { HomepageAgentCore } = require('./agent-core.cjs');

const seed = `# retained comment
- My Own Suite:
    - Suite Manager:
        href: /suite-manager/
        description: Control plane
        icon: mdi:cube
`;
const domainState = { baseDomain: 'mos.example.com', tlsMode: 'cloudflare-dns01' };
const link = { description: 'Useful docs', group: 'Links', icon: 'mdi:link', name: 'Docs', url: 'https://example.com/docs' };
const service = { description: 'Office printer', group: 'Home services', host: '192.168.1.20', icon: 'mdi:printer', name: 'Printer', port: 8080, protocol: 'http', subdomain: 'printer' };
const calendarLink = {
  ...link,
  name: 'Calendar',
  widget: {
    integrations: [{ color: 'cyan', name: 'My Calendar', type: 'ical', url: 'https://radicale.mos.example.com/__mos-v2/ical/token-value' }],
    maxEvents: 8,
    showTime: true,
    type: 'calendar',
    view: 'monthly',
  },
};
const id = '12345678-1234-4123-8123-123456789abc';

function adapter(content = seed) {
  const transactions = [];
  return {
    transactions,
    async readHomepageFile() { return content; },
    async applyTransaction(input) { transactions.push(input); content = input.files['services.template.yaml'] || content; return { steps: ['staged', 'validated', 'written'] }; },
  };
}

test('allowlist rejects traversal and YAML parser reports structured errors', async () => {
  const fake = adapter();
  await assert.rejects(() => new HomepageAgentCore(fake).read({ file: '../Caddyfile' }), (error) => error.code === 'HOMEPAGE_FILE_NOT_ALLOWED');
  assert.throws(() => validateYaml('- broken: [', 'services.template.yaml'), (error) => error.code === 'INVALID_HOMEPAGE_YAML' && error.details.length > 0);
});

test('guided links preserve comments and stable IDs make retries idempotent', () => {
  const first = addEntry(seed, link, { id });
  assert.match(first.content, /retained comment/u);
  assert.match(first.content, new RegExp(id, 'u'));
  const retry = addEntry(first.content, link, { id });
  assert.equal(retry.changed, false);
  assert.equal(retry.content, first.content);
});

test('guided package links can include a constrained calendar widget', () => {
  const added = addEntry(seed, calendarLink, { id });
  const projection = projectServices(added.content, domainState);

  assert.match(projection, /widget:/u);
  assert.match(projection, /type: calendar/u);
  assert.match(projection, /url: https:\/\/radicale\.mos\.example\.com\/__mos-v2\/ical\/token-value/u);
  assert.throws(() => addEntry(seed, {
    ...calendarLink,
    widget: {
      ...calendarLink.widget,
      integrations: [{ ...calendarLink.widget.integrations[0], url: 'https://user:secret@radicale.mos.example.com/calendar.ics' }],
    },
  }, { id }), /without credentials/u);
});

test('guided link removal uses stable MOS IDs and leaves other entries alone', () => {
  const first = addEntry(seed, link, { id });
  const secondId = '22345678-1234-4123-8123-123456789abc';
  const second = addEntry(first.content, { ...link, name: 'Other Docs' }, { id: secondId });
  const removed = removeEntryById(second.content, id);

  assert.equal(removed.changed, true);
  assert.doesNotMatch(removed.content, new RegExp(id, 'u'));
  assert.match(removed.content, new RegExp(secondId, 'u'));
  assert.equal(removeEntryById(removed.content, id).changed, false);
});

test('home services generate a clean projection and a separate escaped Caddy route', () => {
  const added = addEntry(seed, service, { homeService: true, id });
  const projection = projectServices(added.content, domainState);
  const routes = renderCaddyRoutes(added.content, domainState);
  assert.match(projection, /https:\/\/printer\.mos\.example\.com\//u);
  assert.doesNotMatch(projection, /mos:/u);
  assert.equal(routes, 'https://printer.mos.example.com {\n  reverse_proxy http://192.168.1.20:8080\n}\n');
  assert.deepEqual(publicUrlFor({ subdomain: 'printer' }, domainState), 'https://printer.mos.example.com/');
});

test('strict proxy metadata rejects duplicates, credentials, directives, and reserved hosts', () => {
  const added = addEntry(seed, service, { homeService: true, id });
  assert.throws(() => addEntry(added.content, { ...service, name: 'Other' }, { homeService: true }), /already used/u);
  for (const invalid of [
    { ...service, host: 'user:secret@192.168.1.20' },
    { ...service, host: '192.168.1.20\nrespond hacked' },
    { ...service, subdomain: 'home' },
    { ...service, port: 70000 },
  ]) assert.throws(() => addEntry(seed, invalid, { homeService: true }));
});

test('agent requires the expected revision and projects only services template saves', async () => {
  const fake = adapter();
  const core = new HomepageAgentCore(fake);
  await assert.rejects(() => core.apply({ content: seed, domainState, expectedRevision: 'old', file: 'services.template.yaml' }), (error) => error.code === 'HOMEPAGE_REVISION_CONFLICT' && error.statusCode === 409);
  const changed = `${seed}\n- Links: []\n`;
  await core.apply({ content: changed, domainState, expectedRevision: revisionFor(seed), file: 'services.template.yaml' });
  assert.deepEqual(Object.keys(fake.transactions[0].files).sort(), ['services.template.yaml', 'services.yaml']);
  assert.equal(fake.transactions[0].restartHomepage, true);
  assert.match(fake.transactions[0].caddyRoutes, /No user-managed/u);
});

test('agent removes guided links through the same transactional projection path', async () => {
  const added = addEntry(seed, link, { id });
  const fake = adapter(added.content);
  const core = new HomepageAgentCore(fake);

  const result = await core.removeLink({ domainState, expectedRevision: revisionFor(added.content), id });

  assert.equal(result.changed, true);
  assert.equal(result.id, id);
  assert.deepEqual(Object.keys(fake.transactions[0].files).sort(), ['services.template.yaml', 'services.yaml']);
  assert.doesNotMatch(fake.transactions[0].files['services.template.yaml'], new RegExp(id, 'u'));
});

test('managed URL reconciliation updates only MOS-owned app IDs and keeps random links untouched', () => {
  const appId = '32345678-1234-4123-8123-123456789abc';
  const randomId = '42345678-1234-4123-8123-123456789abc';
  const withApp = addEntry(seed, { ...link, name: 'Stirling', url: 'http://stirling-pdf.mos.home/' }, { id: appId }).content;
  const withRandom = addEntry(withApp, { ...link, name: 'Docs', url: 'https://example.com/docs' }, { id: randomId }).content;

  const reconciled = reconcileManagedUrls(withRandom, [{ href: 'https://stirling-pdf.mos.example.com/', id: appId }]);

  assert.equal(reconciled.changed, true);
  assert.match(reconciled.content, /href: https:\/\/stirling-pdf\.mos\.example\.com\//u);
  assert.match(reconciled.content, /href: https:\/\/example\.com\/docs/u);
});

test('agent reconciles app URLs while regenerating separate home-service routes', async () => {
  const appId = '32345678-1234-4123-8123-123456789abc';
  const withApp = addEntry(seed, { ...link, name: 'Stirling', url: 'http://stirling-pdf.mos.home/' }, { id: appId }).content;
  const withService = addEntry(withApp, service, { homeService: true, id }).content;
  const fake = adapter(withService);
  const core = new HomepageAgentCore(fake);

  await core.reconcileUrls({
    domainState,
    entries: [{ href: 'https://stirling-pdf.mos.example.com/', id: appId }],
    expectedRevision: revisionFor(withService),
  });

  assert.match(fake.transactions[0].files['services.template.yaml'], /href: https:\/\/stirling-pdf\.mos\.example\.com\//u);
  assert.match(fake.transactions[0].files['services.yaml'], /https:\/\/printer\.mos\.example\.com\//u);
  assert.equal(fake.transactions[0].caddyRoutes, 'https://printer.mos.example.com {\n  reverse_proxy http://192.168.1.20:8080\n}\n');
});

test('agent API has no arbitrary command, path, file, or service operation', async () => {
  const core = new HomepageAgentCore(adapter());
  const status = await core.status();
  assert.deepEqual(status.capabilities, ['homepage.read', 'homepage.apply', 'homepage.add-link', 'homepage.add-home-service', 'homepage.remove-link', 'homepage.reconcile-urls']);
  await assert.rejects(() => core.apply({ command: 'sh', file: 'services.template.yaml' }), HomepageConfigError);
});
