'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { validateManifestSemantics } = require('../src/apps/manifest-semantics.cjs');
const { describeRequestedPermissions } = require('../src/apps/package-contracts.cjs');
const { mcpExportOf } = require('../src/ai/ai-tool-catalog.cjs');

const memosManifest = require(path.resolve(__dirname, '..', '..', '..', 'apps', 'memos', 'manifest.json'));

function withExport(mcp) {
  return { ...memosManifest, exports: { mcp: { ...memosManifest.exports.mcp, ...mcp } } };
}

function exportErrors(manifest) {
  return validateManifestSemantics(manifest).filter((error) => error.startsWith('exports'));
}

test('the Memos package declares its MCP server by service and path, with every tool classed', () => {
  assert.deepEqual(exportErrors(memosManifest), []);
  const mcp = mcpExportOf(memosManifest);
  assert.equal(mcp.service, 'memos');
  assert.equal(mcp.path, '/mcp');
  assert.equal(mcp.tools.get('memo_list_memos').kind, 'read');
  assert.equal(mcp.tools.get('memo_delete_memo').kind, 'destructive');
  assert.deepEqual(mcp.tools.get('memo_create_memo').fixed, { 'body.visibility': 'PRIVATE' });
  assert.deepEqual(mcp.tools.get('memo_update_memo').fixed, { updateMask: 'content' });
  assert.equal(mcp.tokenPage, '/setting#access-token');
});

test('an MCP export cannot point MOS at a URL, an undeclared service or an unclassed tool', () => {
  assert.match(exportErrors(withExport({ url: 'http://169.254.169.254/' })).join('\n'), /must not declare a url/u);
  assert.match(exportErrors(withExport({ service: 'database' })).join('\n'), /service must name a service the package declares/u);
  assert.match(exportErrors(withExport({ path: '/../admin' })).join('\n'), /path must be an absolute path/u);
  assert.match(exportErrors(withExport({ tools: { memo_list_memos: 'admin' } })).join('\n'), /kind must be one of: read, add, change, serious, destructive/u);
  assert.match(exportErrors(withExport({ tools: { memo_create_memo: { fixed: { 'body.visibility': { any: 1 } }, kind: 'add' } } })).join('\n'), /must be a string, number or boolean/u);
  assert.match(exportErrors(withExport({ tools: { memo_create_memo: { fixed: { '../x': 'y' }, kind: 'add' } } })).join('\n'), /not a dotted argument path/u);
  assert.match(exportErrors(withExport({ tools: {} })).join('\n'), /must list at least one tool/u);
  assert.match(exportErrors(withExport({ auth: { kind: 'oauth' } })).join('\n'), /auth.kind must be one of: owner-token, package-secret/u);
  assert.match(exportErrors(withExport({ auth: { kind: 'owner-token', tokenPage: 'https://elsewhere.example/' } })).join('\n'), /auth.tokenPage must be a path in the app/u);
});

test('offering tools to AI clients is a permission an app update must ask consent for', () => {
  assert.ok(describeRequestedPermissions(memosManifest).includes('ai-tools'));
  const { exports: _omitted, ...withoutExport } = memosManifest;
  assert.ok(!describeRequestedPermissions(withoutExport).includes('ai-tools'));
});
