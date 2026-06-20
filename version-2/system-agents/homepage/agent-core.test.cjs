const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HomepageConfigError,
  addEntry,
  projectServices,
  publicUrlFor,
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

test('agent API has no arbitrary command, path, file, or service operation', async () => {
  const core = new HomepageAgentCore(adapter());
  const status = await core.status();
  assert.deepEqual(status.capabilities, ['homepage.read', 'homepage.apply', 'homepage.add-link', 'homepage.add-home-service']);
  await assert.rejects(() => core.apply({ command: 'sh', file: 'services.template.yaml' }), HomepageConfigError);
});
