const fs = require('node:fs');
const path = require('node:path');

// Prose that makes claims to a reader. `CHANGELOG.md` is deliberately absent: it
// is a historical record, so a claim that was true for 0.14.0 is still correct
// there. `site-mos1-reference/` is frozen by the same logic.
const SCANNED = [
  { extensions: ['.md', '.mdx'], dir: path.join('site', 'src', 'content') },
  { extensions: ['.astro'], dir: path.join('site', 'src', 'components') },
  { extensions: ['.astro'], dir: path.join('site', 'src', 'pages') },
  { extensions: ['.md'], dir: 'docs', recursive: false },
];

const SCANNED_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'generated']);

function walk(dir, extensions, recursive, found) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIPPED_DIRECTORIES.has(entry.name)) walk(full, extensions, recursive, found);
    } else if (extensions.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

// Marks the lines a rule must not read as prose. Two things hide there: YAML or
// Astro frontmatter at the top of a file, and fenced code. A version inside a
// JSON example is documentation of a format, not a claim about this release.
function annotate(text) {
  const rawLines = text.split(/\r?\n/u);
  const lines = [];
  let fence = null;
  let frontmatter = rawLines[0] === '---';

  for (const [index, lineText] of rawLines.entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(lineText);
    const isFrontmatterEdge = frontmatter && (index === 0 || lineText === '---');

    if (frontmatter && index > 0 && lineText === '---') frontmatter = false;

    let inCode = Boolean(fence) || isFrontmatterEdge || frontmatter;
    if (fenceMatch && !frontmatter) {
      if (!fence) {
        fence = fenceMatch[1][0];
        inCode = true;
      } else if (fenceMatch[1][0] === fence) {
        fence = null;
        inCode = true;
      }
    }

    lines.push({ inCode, number: index + 1, text: lineText });
  }
  return lines;
}

function scanFiles(repoRoot) {
  const paths = [];
  for (const target of SCANNED) {
    walk(path.join(repoRoot, target.dir), target.extensions, target.recursive !== false, paths);
  }
  for (const file of SCANNED_FILES) {
    const full = path.join(repoRoot, file);
    if (fs.existsSync(full)) paths.push(full);
  }
  // Each package README is rendered verbatim onto its public docs page.
  const appsDir = path.join(repoRoot, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      const readme = path.join(appsDir, entry.name, 'README.md');
      if (entry.isDirectory() && fs.existsSync(readme)) paths.push(readme);
    }
  }

  return paths.sort().map((full) => {
    const text = fs.readFileSync(full, 'utf8');
    return {
      lines: annotate(text),
      path: path.relative(repoRoot, full).split(path.sep).join('/'),
      text,
    };
  });
}

// The line that opened a fence nothing closed, or null. Everything after such a
// line is "code" to `annotate`, which is correct Markdown and also a way to
// hide every claim in the rest of the file from every rule.
function unclosedFenceLine(text) {
  let fence = null;
  let openedAt = null;
  for (const [index, lineText] of text.split(/\r?\n/u).entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(lineText);
    if (!fenceMatch) continue;
    if (!fence) {
      fence = fenceMatch[1][0];
      openedAt = index + 1;
    } else if (fenceMatch[1][0] === fence) {
      fence = null;
    }
  }
  return fence ? openedAt : null;
}

module.exports = { annotate, scanFiles, unclosedFenceLine };
