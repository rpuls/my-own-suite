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

// React clears a synthetic event's currentTarget as soon as the handler
// returns, and a functional state updater is not guaranteed to have run by
// then — React re-invokes updaters during reconciliation, and twice over in
// development. Reading the event inside one therefore works on the first
// keystroke and throws on a later one, which lands as a blank "This page could
// not load" rather than as anything that points at the line. Read the value
// into a local first and close over that.
test('no state updater reads from a synthetic event', () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.tsx')) files.push(fullPath);
    }
  };
  walk(frontendRoot);

  // Each `setSomething((updater) => ...)` call, sliced to its balanced close
  // paren so a multi-line updater is checked whole.
  const updaterBodies = (source) => {
    const bodies = [];
    for (const match of source.matchAll(/set[A-Z][A-Za-z0-9_]*\(\(/gu)) {
      let depth = 0;
      let index = match.index + match[0].length - 2;
      for (; index < source.length; index += 1) {
        if (source[index] === '(') depth += 1;
        else if (source[index] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(source.slice(match.index, index + 1));
    }
    return bodies;
  };

  const offenders = files.flatMap((file) => updaterBodies(fs.readFileSync(file, 'utf8'))
    .filter((body) => /event\.(?:currentTarget|target)/u.test(body))
    .map(() => path.relative(frontendRoot, file).split(path.sep).join('/')));

  assert.deepEqual([...new Set(offenders)].sort(), [], [
    'These files read event.currentTarget inside a state updater, which is null by the time',
    'React runs it: const { value } = event.currentTarget; then close over `value` instead.',
  ].join(' '));
});

test('Apps setup fields prefill from the signed-in owner', () => {
  const shell = fs.readFileSync(path.join(frontendRoot, 'features', 'app-shell', 'AppShell.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppConfigDialog.tsx'), 'utf8');
  assert.match(shell, /<AppsScreen owner=\{owner\} \/>/u);
  assert.match(dialog, /initialSetupConfig\(\{ setup: \{ fields \} \}, owner\)/u);
  assert.match(dialog, /field\.type === 'email' \? owner\.email/u);
  // Manifest defaults may reference the owner; both tokens must resolve.
  assert.match(dialog, /\\\$\\\{owner\\\.email\\\}/u);
  assert.match(dialog, /\\\$\\\{owner\\\.name\\\}/u);
});

test('Apps catalog separates companion apps and hides Homepage controls when absent', () => {
  const apps = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppsScreen.tsx'), 'utf8');

  assert.match(apps, /function isCompanionApp/u);
  assert.match(apps, /Companion apps/u);
  assert.match(apps, /function hasHomepageContribution/u);
  // The Homepage choice is made in the install dialog, and offered only when the
  // package contributes a shortcut and the app is not running yet — MOS has no
  // path for taking one back off again. Keyed to running rather than installed
  // so an app whose install stopped half way is still offered it.
  const configDialog = fs.readFileSync(path.join(frontendRoot, 'features', 'apps', 'AppConfigDialog.tsx'), 'utf8');
  assert.match(apps, /homepageAvailable=\{homepageAvailable\}/u);
  assert.match(configDialog, /homepageAvailable && !running \?/u);
  assert.match(apps, /hasPrimaryAppDestination/u);
});
