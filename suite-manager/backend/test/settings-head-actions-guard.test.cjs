const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendSrc = path.resolve(__dirname, '..', '..', 'frontend', 'src');

// Every directory whose panels render as cards on the Settings page.
const SETTINGS_CARD_DIRECTORIES = ['features/settings', 'features/storage'];

// A bare <button> or <a> as the action, with or without a condition in front.
const RAW_BUTTON_IN_HEAD = /actions=\{\s*(?:[^<{}]*\?\s*)?<(?:button|a)\b/u;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : [fullPath];
  });
}

test('a settings card head never styles its own action button', () => {
  const offenders = SETTINGS_CARD_DIRECTORIES
    .flatMap((directory) => sourceFiles(path.join(frontendSrc, directory)))
    .filter((file) => RAW_BUTTON_IN_HEAD.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(frontendSrc, file).split(path.sep).join('/'))
    .sort();

  assert.deepEqual(offenders, [], [
    `These settings cards put a hand-styled button in their head: ${offenders.join(', ')}.`,
    'Use <PanelHeadButton> from components/ui.tsx, or the settings EditToggle for a card that opens a form.',
    'A head action that picks its own colour, size or icon is how one card ends up green beside five that are not.',
  ].join(' '));
});
