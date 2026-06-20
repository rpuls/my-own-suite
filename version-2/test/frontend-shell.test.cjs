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

test('authenticated page routes render inside the shared shell and route boundary', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  assert.ok(shell.indexOf('suite-shell-header') < shell.indexOf('<RouteBoundary'));
  assert.match(shell, /<RouteBoundary key=\{route\}>/u);
  assert.match(shell, /<CustomizeScreen \/>/u);
});
