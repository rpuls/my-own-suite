'use strict';

// An app whose MCP server MOS ships itself, as Paperless-ngx does: MOS reaches
// it with a key it generated at install, so the owner never handles a token.

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

async function harness() {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-ai-secret-'));
  const secretDir = path.join(stateDir, 'app-secrets');
  const instance = { displayNameSnapshot: 'Paperless-ngx', enabled: true, id: 'inst-paperless', packageId: 'paperless-ngx', status: 'installed' };
  writeSecretFile(secretDir, instance.id, 'aiKey', 'generated-ai-key');
  const presented = [];
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    presented.push(init.headers.Authorization);
    const result = message.method === 'tools/list'
      ? { tools: [{ description: 'Find documents.', inputSchema: { type: 'object' }, name: 'search_documents' }] }
      : { content: [{ text: '#1 "car-insurance"', type: 'text' }] };
    return new Response(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }), { headers: { 'content-type': 'application/json' } });
  };
  const appStore = { getAppInstances: () => [instance] };
  const catalog = new AiToolCatalog({ appPackages: { installedPackageFor: () => ({ aiTools: paperlessTools, manifest: paperless }) }, fetchImpl, secretDir, store: appStore });
  const connections = new AiConnectionsService({ aiStore: new AiStore(new SuiteManagerStore(stateDir)), catalog, fetchImpl, secretDir });
  return { connections, instance, presented, secretDir };
}

test('MOS presents its own key, asks the owner for no token, and never lets one replace it', async () => {
  const h = await harness();
  const source = (await h.connections.status()).sources.find((candidate) => candidate.id === 'paperless-ngx');
  assert.equal(source.token, null);
  assert.deepEqual(source.tools.map((tool) => tool.name), ['paperless_ngx_search_documents']);

  const { client } = h.connections.createClient({ name: 'LM Studio' });
  h.connections.setLevel(client.id, 'paperless-ngx', 'see');
  const result = await h.connections.callTool(h.connections.aiStore.clientById(client.id), 'paperless_ngx_search_documents', { query: 'insurance' });
  assert.equal(result.isError, false);
  assert.ok(h.presented.every((header) => header === 'Bearer generated-ai-key'));

  await assert.rejects(h.connections.setSourceToken('paperless-ngx', 'pasted-token'), { code: 'AI_TOKEN_NOT_NEEDED' });
  assert.throws(() => h.connections.removeSourceToken('paperless-ngx'), { code: 'AI_TOKEN_NOT_NEEDED' });
  assert.equal(fs.readFileSync(secretFilePath(h.secretDir, h.instance.id, 'aiKey'), 'utf8'), 'generated-ai-key');
});
