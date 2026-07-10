const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.join(__dirname, '..', '..', 'suite-manager', 'frontend', 'src');

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
  assert.match(customize, /mos-btn mos-btn-primary/u);
  assert.match(dialog, /Home network app/u);
  assert.match(dialog, /Edit URL subdomain/u);
  assert.match(dialog, /previewHomeService/u);
  assert.match(dialog, /suite-homepage-address-preview/u);
  assert.match(editor, /lintGutter/u);
  assert.match(editor, /lang-yaml/u);
  assert.match(editor, /mosHighlightStyle/u);
});

test('authenticated page routes render inside the shared shell and route boundary', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  assert.ok(shell.indexOf('suite-shell-header') < shell.indexOf('<RouteBoundary'));
  assert.match(shell, /<RouteBoundary key=\{route\}>/u);
  assert.match(shell, /<CustomizeScreen \/>/u);
});

test('Apps host helper repairs stale app host entries after fresh VM resets', () => {
  const apps = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppsScreen.tsx'), 'utf8');
  assert.match(apps, /# BEGIN MOS V2 HYPERV USB SMOKE/u);
  assert.match(apps, /\$names=\$\{hostsLiteral\}/u);
  assert.match(apps, /\$line -eq \$start/u);
  assert.match(apps, /Set-Content -Path \$hostsPath -Value \$next/u);
  assert.doesNotMatch(apps, /if \(-not \(Select-String/u);
});

test('Apps setup email fields default to the signed-in owner email', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  const apps = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppsScreen.tsx'), 'utf8');
  assert.match(shell, /<AppsScreen owner=\{owner\} \/>/u);
  assert.match(apps, /initialSetupConfig\(app, owner\.email\)/u);
  assert.match(apps, /field\.type === 'email' \? ownerEmail/u);
});

test('Apps catalog separates companion apps and hides Homepage controls when absent', () => {
  const apps = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppsScreen.tsx'), 'utf8');

  assert.match(apps, /function isCompanionApp/u);
  assert.match(apps, /Companion apps/u);
  assert.match(apps, /function hasHomepageContribution/u);
  assert.match(apps, /homepageAvailable && !ready && !disabled && !uninstalled/u);
  assert.match(apps, /hasPrimaryAppDestination/u);
});
