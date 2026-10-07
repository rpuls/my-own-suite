const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { changelogSections, unreleasedFormatProblems } = require('../../shared/changelog.cjs');

const changelog = (...unreleased) => ['# Changelog', '', 'About this file.', '', '- a header bullet is not an entry', '', '## [Unreleased]', '', ...unreleased, '', '## [0.1.0] - 2026-09-01', '', '- **Backups exist.** Detail.', ''].join('\n');

test('an entry keeps its sub-bullets and paragraphs, and text before the first section is no entry', () => {
  const sections = changelogSections(changelog('### Fixed', '', '- **Three reviews are corrected.** A capture found:', '  - Stirling PDF', '  - ONLYOFFICE', '', '  Advisories flag the affected versions.'));

  assert.deepEqual(sections, [
    { heading: 'Unreleased', items: ['**Three reviews are corrected.** A capture found:\n- Stirling PDF\n- ONLYOFFICE\n\nAdvisories flag the affected versions.'] },
    { heading: '0.1.0', items: ['**Backups exist.** Detail.'] },
  ]);
});

test('an Unreleased section in the documented shape passes', () => {
  assert.deepEqual(unreleasedFormatProblems(changelog('### Added', '', '- **Backups run on a schedule.** Detail.', '  - daily', '', '### Security', '', '- **Immich closes a flaw.** Detail.')), []);
});

test('what the update screen would show wrongly is refused, by line', () => {
  const problems = unreleasedFormatProblems(changelog(
    '### Improvements',
    '',
    '- Backups run on a schedule.',
    'Retention keeps the last seven.',
    '- **Backups exist.** Said again.',
  ));

  assert.equal(problems.length, 4);
  assert.match(problems[0], /^CHANGELOG\.md:9: "### Improvements" is not one of the groups/u);
  assert.match(problems[1], /^CHANGELOG\.md:11: an entry opens with a bold lead sentence/u);
  assert.match(problems[2], /^CHANGELOG\.md:12: text under \[Unreleased\] is an entry or indented two spaces inside one/u);
  assert.match(problems[3], /the lead "Backups exist\." is used by another entry/u);
});

test('the repository changelog is in the shape the update screen reads', () => {
  assert.deepEqual(unreleasedFormatProblems(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8')), []);
});
