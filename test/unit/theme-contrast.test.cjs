const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mosCss = fs.readFileSync(path.join(__dirname, '..', '..', 'branding', 'styles', 'mos.css'), 'utf8');

function tokenBlock(selector) {
  const start = mosCss.indexOf(`${selector} {`);
  assert.ok(start >= 0, `mos.css has no ${selector} block`);
  const body = mosCss.slice(start, mosCss.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/(--mos-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const dark = tokenBlock(':root');
const themes = { dark, light: { ...dark, ...tokenBlock("[data-theme='light']") } };

function resolve(tokens, name) {
  const value = tokens[name];
  assert.ok(value, `token ${name} is not defined`);
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? resolve(tokens, reference[1]) : value;
}

function rgba(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const fn = value.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(fn, `cannot read colour ${value}`);
  const [r, g, b, a = 1] = fn[1].split(',').map(Number);
  return [r, g, b, a];
}

// Translucent surfaces only have a contrast once painted over something opaque.
function paint(tokens, layers) {
  return layers.reduce((under, name) => {
    const [r, g, b, a] = rgba(resolve(tokens, name));
    return [r, g, b].map((c, i) => c * a + under[i] * (1 - a));
  }, [0, 0, 0]);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PAGE = ['--mos-color-bg'];
const PAGE_SOFT = ['--mos-color-bg-soft'];
const PANEL = ['--mos-color-bg-soft', '--mos-color-surface'];
const PANEL_STRONG = ['--mos-color-bg-soft', '--mos-color-surface-strong'];
const POPOVER = ['--mos-color-bg-soft', '--mos-color-surface-elevated'];
const SELECTED_ROW = ['--mos-color-bg-soft', '--mos-color-surface', '--mos-color-accent-soft'];

const BODY_TEXT = ['--mos-color-text', '--mos-color-text-strong', '--mos-color-text-muted', '--mos-color-accent-text'];
const STATUS_TEXT = ['danger', 'warning', 'info', 'success'];

const PAIRS = [
  ...BODY_TEXT.flatMap((fg) =>
    [PAGE, PAGE_SOFT, PANEL, PANEL_STRONG, POPOVER].map((bg) => ({ fg, bg })),
  ),
  { fg: '--mos-color-accent-text', bg: SELECTED_ROW },
  { fg: '--mos-color-text', bg: SELECTED_ROW },
  { fg: '--mos-color-link-hover', bg: PANEL_STRONG },
  ...STATUS_TEXT.flatMap((status) => [
    { fg: `--mos-color-${status}`, bg: PANEL_STRONG },
    { fg: `--mos-color-${status}`, bg: POPOVER },
    { fg: `--mos-color-${status}`, bg: [...PANEL, `--mos-color-${status}-soft`] },
  ]),
  { fg: '--mos-color-button-primary-text', bg: ['--mos-color-primary-start'] },
  { fg: '--mos-color-button-primary-text', bg: ['--mos-color-primary-end'] },
];

for (const [theme, tokens] of Object.entries(themes)) {
  test(`${theme} theme text tokens meet WCAG AA on the surfaces they sit on`, () => {
    const failures = PAIRS.map(({ fg, bg }) => ({ fg, bg, ratio: contrast(paint(tokens, [fg]), paint(tokens, bg)) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ fg, bg, ratio }) => `${fg} on ${bg.join(' + ')}: ${ratio.toFixed(2)}:1`);
    assert.deepEqual(failures, []);
  });
}
