'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateAiTools } = require('../src/apps/ai-tools-file.cjs');
const { validateManifestSemantics } = require('../src/apps/manifest-semantics.cjs');
const { describeRequestedPermissions } = require('../src/apps/package-contracts.cjs');
const { mcpExportOf } = require('../src/ai/ai-tool-catalog.cjs');

const memosDir = path.resolve(__dirname, '..', '..', '..', 'apps', 'memos');
const memosManifest = require(path.join(memosDir, 'manifest.json'));
const memosTools = require(path.join(memosDir, 'ai-tools.json'));

function withExport(mcp) {
  return { ...memosManifest, exports: { mcp: { ...memosManifest.exports.mcp, ...mcp } } };
}

function exportErrors(manifest, options) {
  return validateManifestSemantics(manifest, options).filter((error) => /^exports|ai-tools\.json/u.test(error));
}

function withToolsFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-ai-tools-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'ai-tools.json'), contents);
  return dir;
}

test('the Memos package declares its MCP server by service and path, and its tools beside the manifest', () => {
  assert.deepEqual(exportErrors(memosManifest, { packageDir: memosDir }), []);
  const mcp = mcpExportOf(memosManifest, memosTools);
  assert.equal(mcp.service, 'memos');
  assert.equal(mcp.path, '/mcp');
  assert.equal(mcp.tools.get('memo_list_memos').kind, 'read');
  assert.equal(mcp.tools.get('memo_delete_memo').kind, 'destructive');
  assert.deepEqual(mcp.tools.get('memo_create_memo').fixed, { 'body.visibility': 'PRIVATE' });
  assert.deepEqual(mcp.tools.get('memo_update_memo').fixed, { updateMask: 'content' });
  assert.equal(mcp.tokenPage, '/setting#access-token');
});

test('an MCP export cannot point MOS at a URL or an undeclared service, nor list its tools in the manifest', () => {
  assert.match(exportErrors(withExport({ url: 'http://169.254.169.254/' })).join('\n'), /must not declare a url/u);
  assert.match(exportErrors(withExport({ service: 'database' })).join('\n'), /service must name a service the package declares/u);
  assert.match(exportErrors(withExport({ path: '/../admin' })).join('\n'), /path must be an absolute path/u);
  assert.match(exportErrors(withExport({ tools: { memo_list_memos: 'read' } })).join('\n'), /tools belongs in ai-tools.json/u);
  assert.match(exportErrors(withExport({ auth: { kind: 'oauth' } })).join('\n'), /auth.kind must be one of: owner-token, package-secret/u);
  assert.match(exportErrors(withExport({ auth: { kind: 'owner-token', tokenPage: 'https://elsewhere.example/' } })).join('\n'), /auth.tokenPage must be a path in the app/u);
});

test('the export and its tools file come together, and a broken file is an error rather than no tools', () => {
  assert.match(exportErrors(memosManifest, { packageDir: withToolsFile() }).join('\n'), /needs ai-tools.json beside the manifest/u);
  assert.match(exportErrors(memosManifest, { packageDir: withToolsFile('{ not json') }).join('\n'), /ai-tools.json is not valid JSON/u);
  const { exports: _omitted, ...withoutExport } = memosManifest;
  assert.match(exportErrors(withoutExport, { packageDir: withToolsFile(JSON.stringify(memosTools)) }).join('\n'), /ai-tools.json needs an exports entry of type mcp-server/u);
});

test('every listed tool has a reviewed kind, and fixed arguments are plain values at dotted paths', () => {
  const errorsFor = (tools) => validateAiTools({ schemaVersion: 1, tools }).join('\n');
  assert.deepEqual(validateAiTools(memosTools), []);
  assert.match(errorsFor({ memo_list_memos: 'admin' }), /kind must be one of: read, add, change, serious, destructive/u);
  assert.match(errorsFor({ memo_create_memo: { fixed: { 'body.visibility': { any: 1 } }, kind: 'add' } }), /must be a string, number or boolean/u);
  assert.match(errorsFor({ memo_create_memo: { fixed: { '../x': 'y' }, kind: 'add' } }), /not a dotted argument path/u);
  assert.match(errorsFor({ memo_create_memo: { fixed: { 'body/visibility': 'y' }, kind: 'add' } }), /not a dotted argument path/u);
  assert.match(errorsFor({}), /must list at least one tool/u);
  assert.match(validateAiTools({ tools: memosTools.tools }).join('\n'), /schemaVersion must be 1/u);
});

test('offering tools to AI clients is a permission an app update must ask consent for', () => {
  assert.ok(describeRequestedPermissions(memosManifest).includes('ai-tools'));
  const { exports: _omitted, ...withoutExport } = memosManifest;
  assert.ok(!describeRequestedPermissions(withoutExport).includes('ai-tools'));
});
