const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const frontendSrc = path.join(repoRoot, 'suite-manager', 'frontend', 'src');
const ADVANCED_CLASS = 'suite-advanced';

// The two files that are allowed to know the class name: the shared component
// that renders it, and the stylesheet that styles it.
const OWNERS = ['components/ui.tsx', 'styles/index.css'];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : [fullPath];
  });
}

test('only the shared AdvancedPanel and its stylesheet know the advanced-panel class', () => {
  const offenders = sourceFiles(frontendSrc)
    .filter((file) => fs.readFileSync(file, 'utf8').includes(ADVANCED_CLASS))
    .map((file) => path.relative(frontendSrc, file).split(path.sep).join('/'))
    .filter((relativePath) => !OWNERS.includes(relativePath))
    .sort();

  assert.deepEqual(offenders, [], [
    `These files render the .${ADVANCED_CLASS} class themselves: ${offenders.join(', ')}.`,
    'Advanced surface must go through <AdvancedPanel> in components/ui.tsx, which decides its own',
    'visibility: it renders nothing at all unless the owner has switched technical controls on',
    '(reveal="technical-mode"), or the surrounding UI is already reporting a failure',
    '(reveal="on-failure"). A hand-rolled disclosure skips that gate, so package ids, digests, ports,',
    'volume names and raw logs go back in front of every owner on a healthy screen — which is the',
    'clutter the shared panel was built to remove, and the reason no screen is allowed to write this',
    'class. Use AdvancedPanel rather than deleting this test.',
  ].join(' '));
});
