'use strict';

// An app whose MCP server MOS ships itself, as Paperless-ngx does: MOS reaches
// it with a key it generated at install. Paperless also needs the owner's own
// token, which MOS gets by signing in with the owner's password once.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AiConnectionsService } = require('../src/ai/ai-connections-service.cjs');
const { AiStore } = require('../src/ai/ai-store.cjs');
const { AiToolCatalog, mcpExportOf } = require('../src/ai/ai-tool-catalog.cjs');
const { renderDryRunProjections, secretFilePath, writeSecretFile } = require('../src/apps/app-package-internals.cjs');
const { validateManifestSemantics } = require('../src/apps/manifest-semantics.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const appsDir = path.resolve(__dirname, '..', '..', '..', 'apps');
const paperlessDir = path.join(appsDir, 'paperless-ngx');
const paperless = require(path.join(paperlessDir, 'manifest.json'));
const paperlessTools = require(path.join(paperlessDir, 'ai-tools.json'));
const memos = require(path.join(appsDir, 'memos', 'manifest.json'));

function withAuth(auth) {
  return { ...paperless, exports: { ...paperless.exports, mcp: { ...paperless.exports.mcp, auth } } };
}

function exportErrors(manifest) {
  return validateManifestSemantics(manifest, { packageDir: paperlessDir }).filter((error) => error.startsWith('exports'));
}

test('Paperless offers its own MCP service, reached with a key MOS generates', () => {
  assert.deepEqual(exportErrors(paperless), []);
  const mcp = mcpExportOf(paperless, paperlessTools);
  assert.equal(mcp.service, 'mcp');
  assert.equal(mcp.packageSecret, 'aiKey');
  assert.equal(mcp.tools.get('update_document').kind, 'change');
});

test('a package secret must be one MOS generates, never one the owner typed', () => {
  assert.match(exportErrors(withAuth({ kind: 'package-secret', secret: 'adminPassword' })).join('\n'), /auth.secret must name a generated secret setup field/u);
  assert.match(exportErrors(withAuth({ kind: 'package-secret', secret: 'ocrLanguage' })).join('\n'), /auth.secret must name a generated secret setup field/u);
  assert.match(exportErrors(withAuth({ kind: 'package-secret' })).join('\n'), /auth.secret must name a generated secret setup field/u);
});

test('only an MCP service no route reaches is marked for loopback', () => {
  const services = (manifest) => renderDryRunProjections(manifest).find((projection) => projection.kind === 'compose').content.services;
  assert.deepEqual(services(paperless).map((service) => [service.id, service.loopback === true]), [['broker', false], ['paperless', false], ['mcp', true]]);
  assert.ok(services(memos).every((service) => !('loopback' in service)));
});

const OWNER_PASSWORD = 'owner-paperless-password';

// The package's MCP service as the tests need it: /sign-in trades the owner's
// password for the app's token, and a call with a revoked token is refused.
async function harness(manifest = paperless) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-ai-secret-'));
  const secretDir = path.join(stateDir, 'app-secrets');
  const instance = { displayNameSnapshot: 'Paperless-ngx', enabled: true, id: 'inst-paperless', packageId: 'paperless-ngx', status: 'installed' };
  writeSecretFile(secretDir, instance.id, 'aiKey', 'generated-ai-key');
  const presented = [];
  const signIns = [];
  const app = { token: 'app-token-1' };
  const fetchImpl = async (url, init) => {
    presented.push({ appToken: init.headers['X-MOS-App-Token'] ?? null, key: init.headers.Authorization });
    if (new URL(url).pathname === '/sign-in') {
      const { password } = JSON.parse(init.body);
      signIns.push(password);
      return password === OWNER_PASSWORD
        ? new Response(JSON.stringify({ token: app.token }), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'Paperless did not accept that password.' }), { status: 401 });
    }
    const message = JSON.parse(init.body);
    const refused = (init.headers['X-MOS-App-Token'] ?? null) !== app.token;
    const result = message.method === 'tools/list'
      ? { tools: [{ description: 'Find documents.', inputSchema: { type: 'object' }, name: 'search_documents' }] }
      : refused
        ? { _meta: { 'myownsuite.org/sign-in': 'refused' }, content: [{ text: 'Paperless no longer accepts the sign-in.', type: 'text' }], isError: true }
        : { content: [{ text: '#1 "car-insurance"', type: 'text' }] };
    return new Response(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }), { headers: { 'content-type': 'application/json' } });
  };
  const appStore = { getAppInstances: () => [instance] };
  const catalog = new AiToolCatalog({ appPackages: { installedPackageFor: () => ({ aiTools: paperlessTools, manifest }) }, fetchImpl, secretDir, store: appStore });
  const connections = new AiConnectionsService({ aiStore: new AiStore(new SuiteManagerStore(stateDir)), catalog, fetchImpl, secretDir });
  const { client } = connections.createClient({ name: 'LM Studio' });
  connections.setLevel(client.id, 'paperless-ngx', 'see');
  const search = () => connections.callTool(connections.aiStore.clientById(client.id), 'paperless_ngx_search_documents', { query: 'insurance' });
  const paperlessSource = async () => (await connections.status()).sources.find((candidate) => candidate.id === 'paperless-ngx');
  return { app, connections, instance, paperlessSource, presented, search, secretDir, signIns };
}

test('a package MOS reaches with its own key alone asks the owner for nothing, and never lets a token replace that key', async () => {
  const h = await harness(withAuth({ kind: 'package-secret', secret: 'aiKey' }));
  const source = await h.paperlessSource();
  assert.equal(source.token, null);
  assert.deepEqual(source.tools.map((tool) => tool.name), ['paperless_ngx_search_documents']);

  h.app.token = null;
  assert.equal((await h.search()).isError, false);
  assert.ok(h.presented.every((call) => call.key === 'Bearer generated-ai-key' && call.appToken === null));

  await assert.rejects(h.connections.setSourceToken('paperless-ngx', 'pasted-token'), { code: 'AI_TOKEN_NOT_NEEDED' });
  assert.throws(() => h.connections.removeSourceToken('paperless-ngx'), { code: 'AI_TOKEN_NOT_NEEDED' });
  await assert.rejects(h.connections.signInToSource('paperless-ngx', OWNER_PASSWORD), { code: 'AI_TOKEN_NOT_NEEDED' });
  assert.equal(fs.readFileSync(secretFilePath(h.secretDir, h.instance.id, 'aiKey'), 'utf8'), 'generated-ai-key');
});

test('Paperless asks for the owner password once, and MOS keeps only the token it gets back', async () => {
  const h = await harness();
  assert.deepEqual((await h.paperlessSource()).token, { configured: false, hint: null, signIn: true, tokenPageUrl: null, verifiedAt: null });
  assert.equal((await h.search()).isError, true);

  await assert.rejects(h.connections.signInToSource('paperless-ngx', 'wrong'), { code: 'AI_PASSWORD_REJECTED' });
  await assert.rejects(h.connections.setSourceToken('paperless-ngx', 'pasted-token'), { code: 'AI_SIGN_IN_NEEDED' });
  await h.connections.signInToSource('paperless-ngx', OWNER_PASSWORD);
  assert.equal((await h.paperlessSource()).token.configured, true);

  assert.equal((await h.search()).isError, false);
  assert.deepEqual(h.presented.at(-1), { appToken: 'app-token-1', key: 'Bearer generated-ai-key' });
  const stored = fs.readdirSync(path.join(h.secretDir, h.instance.id)).map((name) => fs.readFileSync(path.join(h.secretDir, h.instance.id, name), 'utf8'));
  assert.ok(!stored.some((value) => value.includes(OWNER_PASSWORD)));
});

test('a token the app no longer accepts is dropped, so the owner is asked to sign in again', async () => {
  const h = await harness();
  await h.connections.signInToSource('paperless-ngx', OWNER_PASSWORD);
  h.app.token = 'app-token-2';

  const refused = await h.search();
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /sign in again/u);
  assert.equal((await h.paperlessSource()).token.configured, false);

  await h.connections.signInToSource('paperless-ngx', OWNER_PASSWORD);
  assert.equal((await h.search()).isError, false);
});

test('a sign-in path must be a path on the package service itself', () => {
  assert.match(exportErrors(withAuth({ kind: 'package-secret', secret: 'aiKey', signIn: 'http://elsewhere/sign-in' })).join('\n'), /auth.signIn must be an absolute path/u);
  assert.match(exportErrors(withAuth({ kind: 'package-secret', secret: 'aiKey', signIn: '/../sign-in' })).join('\n'), /auth.signIn must be an absolute path/u);
});
