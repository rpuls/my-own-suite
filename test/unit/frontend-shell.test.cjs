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

test('Customize offers one save, and offers a reload only when the file conflicts', () => {
  const customize = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'CustomizeScreen.tsx'), 'utf8');

  // Validating was a second click in front of the only action anyone wanted,
  // and a permanent Reload saved button implied the editor routinely shows
  // stale content. Both are gone; the agent still validates before it writes.
  assert.doesNotMatch(customize, /'Validate'/u);
  assert.doesNotMatch(customize, /Reload saved/u);
  assert.doesNotMatch(customize, /validatedContent/u);
  assert.match(customize, /HOMEPAGE_REVISION_CONFLICT/u);
  assert.match(customize, /Discard my changes and reload/u);
});

test('Customize says out loud that it is a raw YAML editor', () => {
  const customize = fs.readFileSync(path.join(frontendRoot, 'features', 'customize', 'CustomizeScreen.tsx'), 'utf8');
  assert.match(customize, /<CustomizeYamlNotice \/>/u);
});

test('authenticated page routes render inside the shared shell and route boundary', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  assert.ok(shell.indexOf('suite-shell-header') < shell.indexOf('<RouteBoundary'));
  assert.match(shell, /<RouteBoundary key=\{route\}>/u);
  assert.match(shell, /<CustomizeScreen \/>/u);
});

// The app catalog used to end in an Advanced details block holding a PowerShell
// snippet that rewrote the Windows hosts file for the Hyper-V smoke lab. It was
// lab scaffolding on a page every owner sees, so it is gone; this keeps it gone.
test('the app catalog does not ship lab host-file tooling to owners', () => {
  const apps = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppsScreen.tsx'), 'utf8');
  assert.doesNotMatch(apps, /HYPERV USB SMOKE/u);
  assert.doesNotMatch(apps, /hostsPath/u);
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
