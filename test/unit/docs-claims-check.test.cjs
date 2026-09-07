const assert = require('node:assert/strict');
const test = require('node:test');

const { RULES } = require('../../scripts/docs-claims/rules/index.cjs');
const { annotate } = require('../../scripts/docs-claims/scan.cjs');

// Every test here is synthetic. A test that read the real documentation would
// fail whenever somebody edited a page, which is exactly the flakiness this
// repository avoids — and it would stop testing the rule.
const FACTS = {
  catalogIds: ['alpha-app', 'beta-app', 'gamma-app'],
  categories: ['files', 'photos'],
  packages: [
    { category: 'files', id: 'alpha-app', name: 'Alpha App' },
    { category: 'photos', id: 'beta-app', name: 'Beta App' },
    { category: 'files', id: 'gamma-app', name: 'Gamma App' },
  ],
  stableVersion: '1.2.3',
  version: '1.2.3',
};

function file(path, text) {
  return { lines: annotate(text), path, text };
}

function run(id, files, facts = FACTS) {
  const rule = RULES.find((entry) => entry.id === id);
  assert.ok(rule, `no rule named ${id}`);
  const scoped = rule.skipPaths ? files.filter((entry) => !rule.skipPaths.includes(entry.path)) : files;
  return rule.run({ facts, files: scoped });
}

function messages(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line}`);
}

test('every rule has an id and a title, and ids are unique', () => {
  const ids = RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of RULES) {
    assert.equal(typeof rule.title, 'string');
    assert.ok(rule.title.length > 0, `${rule.id} has no title`);
    assert.equal(typeof rule.run, 'function');
  }
});

test('annotate marks frontmatter and fenced code as non-prose', () => {
  const lines = annotate([
    '---',
    'title: Example',
    '---',
    'prose line',
    '```json',
    'fenced line',
    '```',
    'after fence',
  ].join('\n'));

  assert.deepEqual(lines.map((line) => line.inCode), [true, true, true, false, true, true, true, false]);
  assert.equal(lines[3].number, 4);
});

test('app-count fails on a wrong catalog count and passes on the right one', () => {
  const wrong = run('app-count', [
    file('README.md', 'MOS ships with six catalog apps today.'),
    file('site/a.md', 'There are 12 apps in the catalog.'),
    file('site/b.md', 'The catalog contains four apps.'),
  ]);
  assert.deepEqual(messages(wrong), ['README.md:1', 'site/a.md:1', 'site/b.md:1']);

  const right = run('app-count', [
    file('README.md', 'MOS ships with three catalog apps today.'),
    file('site/a.md', 'There are 3 apps in the catalog.'),
  ]);
  assert.deepEqual(right, []);
});

test('app-count ignores counts that are not about the catalog', () => {
  const findings = run('app-count', [
    file('site/a.md', 'Install two apps to get started, then add a third.'),
    file('site/b.md', 'Most people run five apps on a small server.'),
  ]);
  assert.deepEqual(findings, []);
});

test('app-count does not read a number out of fenced code', () => {
  const findings = run('app-count', [
    file('site/a.md', ['Prose.', '```', 'six catalog apps', '```'].join('\n')),
  ]);
  assert.deepEqual(findings, []);
});

test('app-names rejects a link to an app that is not in the catalog', () => {
  const findings = run('app-names', [
    file('site/a.md', 'Try [Alpha](/docs/apps/alpha-app/) or [Ghost](/docs/apps/ghost-app/).'),
    file('site/b.md', 'And [Beta](/docs/apps/beta-app/) and [Gamma](/docs/apps/gamma-app/).'),
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /ghost-app/u);
  assert.equal(findings[0].line, 1);
});

test('app-names does not report packages nothing names, because every package has a generated page', () => {
  const findings = run('app-names', [
    file('site/a.md', 'Only [Alpha](/docs/apps/alpha-app/) is mentioned.'),
  ]);
  assert.deepEqual(findings, []);
});

// An unclosed fence makes everything after it "code" to the fence tracker, so
// one stray backtick line would silence every other rule for the rest of the
// file — in a checker that deliberately has no suppression mechanism.
test('code-fences reports a fence that never closes, and nothing else', () => {
  const stray = file('site/b.md', ['Intro.', '```', 'const x = 1;', 'Claims after this are hidden.'].join(String.fromCharCode(10)));
  const closed = file('site/c.md', ['Intro.', '```', 'const x = 1;', '```', 'Prose again.'].join(String.fromCharCode(10)));
  assert.deepEqual(messages(run('code-fences', [stray, closed])), ['site/b.md:2']);
});

test('version-references fails only on a version presented as current', () => {
  const stale = run('version-references', [
    file('site/a.md', 'The current release is 1.0.0.'),
    file('site/b.md', 'See https://github.com/rpuls/my-own-suite/releases/tag/v0.9.1 for notes.'),
    file('site/c.md', 'MOS 1.1.0 is the latest version.'),
  ]);
  assert.deepEqual(messages(stale), ['site/a.md:1', 'site/b.md:1', 'site/c.md:1']);

  const current = run('version-references', [
    file('site/a.md', 'The current release is 1.2.3.'),
    file('site/b.md', 'Download v1.2.3 from the releases page.'),
  ]);
  assert.deepEqual(current, []);
});

test('version-references leaves historical version facts alone', () => {
  // "Added in MOS 0.18.0" is permanently correct and must never be rewritten to
  // the current version, which is the failure mode a blunter rule would cause.
  const findings = run('version-references', [
    file('site/a.md', 'Added in MOS 0.18.0. Optional and advisory.'),
    file('site/b.md', 'The namespace was added in **MOS 0.19.0**; set `minimumMosVersion` to `0.19.0`.'),
    file('site/c.md', 'Backups written by MOS 0.19 or earlier can no longer be restored.'),
  ]);
  assert.deepEqual(findings, []);
});

test('promised-soon fails on an unlinked promise and passes when an issue is linked', () => {
  const unlinked = run('promised-soon', [
    file('site/a.md', 'Managed hosting is coming soon.'),
    file('site/b.md', 'Full-disk encryption is planned.'),
    file('site/c.astro', '<li>Planned — not yet available</li>'),
  ]);
  assert.deepEqual(messages(unlinked), ['site/a.md:1', 'site/b.md:1', 'site/c.astro:1']);

  const linked = run('promised-soon', [
    file('site/a.md', 'Full-disk encryption is planned ([#42](https://github.com/rpuls/my-own-suite/issues/42)).'),
  ]);
  assert.deepEqual(linked, []);
});

test('promised-soon ignores timing and direction, and quoted reports of a promise', () => {
  const findings = run('promised-soon', [
    file('site/a.md', 'It takes one backup shortly after starting again.'),
    file('site/b.md', 'Secrets are redacted on the way in, never on the way out.'),
    file('site/c.md', 'Three site spots currently promise it as "on the way".'),
    file('site/d.md', 'Planned maintenance happens on Sundays.'),
  ]);
  assert.deepEqual(findings, []);
});

test('placeholders fails on real markers and ignores the words used in prose', () => {
  const found = run('placeholders', [
    file('site/a.md', 'TODO: write this section'),
    file('site/b.md', '- FIXME this link'),
    file('site/c.md', '<!-- placeholder for the diagram -->'),
    file('site/d.md', 'Lorem ipsum dolor sit amet.'),
  ]);
  assert.deepEqual(messages(found), ['site/a.md:1', 'site/b.md:1', 'site/c.md:1', 'site/d.md:1']);

  // The documentation map legitimately forbids "roadmap, TODO, backlog" files.
  const prose = run('placeholders', [
    file('docs/README.md', 'Do not create additional roadmap, TODO, backlog, or planning documents.'),
  ]);
  assert.deepEqual(prose, []);
});

test('a rule that declares skipPaths does not read those files', () => {
  const appCount = RULES.find((rule) => rule.id === 'app-count');
  assert.deepEqual(appCount.skipPaths, ['docs/decisions.md']);

  const findings = run('app-count', [
    file('docs/decisions.md', 'Adding a privacy review to all six catalog apps under unchanged versions.'),
  ]);
  assert.deepEqual(findings, []);
});
