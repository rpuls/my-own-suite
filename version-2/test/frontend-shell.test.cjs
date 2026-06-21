const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.join(__dirname, '..', 'suite-manager', 'frontend', 'src');

test('Customize request IDs work without crypto.randomUUID', () => {
  const customize = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'CustomizeScreen.tsx'), 'utf8');
  assert.doesNotMatch(customize, /crypto\.randomUUID/u);
  assert.match(customize, /function createRequestId/u);
  assert.match(customize, /getRandomValues/u);
});

test('Customize reuses the proven file editor, validation, and guided add workflow', () => {
  const customize = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'CustomizeScreen.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'AddHomepageItemDialog.tsx'), 'utf8');
  const editor = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'CodeEditor.tsx'), 'utf8');
  assert.match(customize, /suite-file-list/u);
  assert.match(customize, /'Validate'/u);
  assert.match(customize, /Save and apply/u);
  assert.match(customize, /Add to Homepage/u);
  assert.match(dialog, /Home network app/u);
  assert.match(dialog, /Edit subdomain/u);
  assert.match(dialog, /previewHomeService/u);
  assert.match(editor, /lintGutter/u);
  assert.match(editor, /lang-yaml/u);
});

test('authenticated page routes render inside the shared shell and route boundary', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  assert.ok(shell.indexOf('suite-shell-header') < shell.indexOf('<RouteBoundary'));
  assert.match(shell, /<RouteBoundary key=\{route\}>/u);
  assert.match(shell, /<CustomizeScreen \/>/u);
});
