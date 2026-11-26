const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const SOURCE_ROOTS = ['suite-manager/frontend/src', 'site/src'];
const DRAWING_OWNERS = [
  'site/src/components/AiDirectionHouse.astro',
  'site/src/components/AiDirectionPicture.astro',
  'site/src/lib/ai-drawing.ts',
  'suite-manager/frontend/src/components/ai-drawing.ts',
  'suite-manager/frontend/src/components/ui.tsx',
];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(fullPath);
    return /\.(astro|mdx|ts|tsx)$/u.test(entry.name) ? [fullPath] : [];
  });
}

function filesMatching(pattern) {
  return SOURCE_ROOTS
    .flatMap((root) => sourceFiles(path.join(repoRoot, root)))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
    .filter((file) => pattern.test(fs.readFileSync(path.join(repoRoot, file), 'utf8')))
    .sort();
}

test('only the shared twins draw the AI direction picture', () => {
  const drawers = filesMatching(/mos-ai-pic|M28 47 L56 25 L84 47/u).filter((file) => !DRAWING_OWNERS.includes(file));
  assert.deepEqual(drawers, [], [
    `These files draw the AI direction picture themselves: ${drawers.join(', ')}.`,
    'Render <AiDirectionPicture> from components/ui.tsx, or AiDirectionPicture.astro on the site.',
  ].join(' '));
});

test('the retired word-pill strip and picture classes stay gone', () => {
  assert.deepEqual(filesMatching(/mos-direction\b|suite-ai-art/u), []);
  assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'branding/styles/mos.css'), 'utf8'), /\.mos-direction\b/u);
});

test('both icon sets draw the AI icons from the twin geometry', () => {
  const ui = fs.readFileSync(path.join(repoRoot, 'suite-manager/frontend/src/components/ui.tsx'), 'utf8');
  const sprite = fs.readFileSync(path.join(repoRoot, 'site/src/components/IconSprite.astro'), 'utf8');
  assert.match(ui, /'chat-spark': aiIcon\('chat-spark'\)/u);
  assert.match(ui, /'chip-spark': aiIcon\('chip-spark'\)/u);
  assert.match(sprite, /import \{ AI_ICON_PATHS \} from '\.\.\/lib\/ai-drawing'/u);
  assert.match(sprite, /AI_ICON_PATHS\)\.map/u);
});
