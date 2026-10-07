// CHANGELOG.md as the update screen reads it. The format is written down at the top
// of CHANGELOG.md, and `npm run release:check` holds [Unreleased] to it with the
// same parser, so what a writer is told and what an owner sees cannot drift apart.

const ENTRY_KINDS = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

// Each `## [heading]` section's top-level bullets, newest section first. A bullet
// keeps its sub-bullets and continuation lines, so an entry reads as in the file.
function changelogSections(changelog) {
  const sections = [];
  let entry = null;
  for (const line of String(changelog).split(/\r?\n/u)) {
    const heading = /^## \[([^\]]+)\]/u.exec(line);
    if (heading) {
      sections.push({ heading: heading[1], items: [] });
      entry = null;
    } else if (sections.length && line.startsWith('- ')) {
      entry = [line.slice(2)];
      sections.at(-1).items.push(entry);
    } else if (entry && (/^\s/u.test(line) || !line.trim())) {
      entry.push(line.replace(/^ {2}/u, ''));
    } else {
      entry = null;
    }
  }
  return sections.map(({ heading, items }) => ({ heading, items: items.map((lines) => lines.join('\n').trim()) }));
}

// The bold lead is an entry's title on the update screen and its identity: a server
// is shown only the entries whose lead its own changelog does not have yet.
function changeLead(item) {
  return /^\*\*(.+?)\*\*/su.exec(item)?.[1] ?? item;
}

function unreleasedFormatProblems(changelog) {
  const lines = String(changelog).split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith('## [Unreleased]'));
  if (start < 0) return [];
  const problems = [];
  let inEntry = false;
  for (let index = start + 1; index < lines.length && !lines[index].startsWith('## '); index += 1) {
    const line = lines[index];
    const at = `CHANGELOG.md:${index + 1}`;
    if (!line.trim()) continue;
    if (line.startsWith('### ')) {
      inEntry = false;
      if (!ENTRY_KINDS.includes(line.slice(4).trim())) problems.push(`${at}: "${line}" is not one of the groups ${ENTRY_KINDS.join(', ')}.`);
    } else if (line.startsWith('- ')) {
      inEntry = true;
      if (!/^- \*\*.+?\*\*/u.test(line)) problems.push(`${at}: an entry opens with a bold lead sentence: "- **What changed.** Detail".`);
    } else if (!inEntry || !line.startsWith('  ')) {
      problems.push(`${at}: text under [Unreleased] is an entry or indented two spaces inside one; the update screen drops anything else.`);
    }
  }

  const sections = changelogSections(changelog);
  const leadsElsewhere = new Set(sections.filter((section) => section.heading !== 'Unreleased').flatMap((section) => section.items.map(changeLead)));
  const seen = new Set();
  for (const item of sections.find((section) => section.heading === 'Unreleased')?.items || []) {
    const lead = changeLead(item);
    if (seen.has(lead) || leadsElsewhere.has(lead)) problems.push(`CHANGELOG.md: the lead "${lead}" is used by another entry; each entry needs its own.`);
    seen.add(lead);
  }
  return problems;
}

module.exports = { ENTRY_KINDS, changeLead, changelogSections, unreleasedFormatProblems };
