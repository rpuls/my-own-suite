#!/usr/bin/env node
const path = require('node:path');

const { collectFacts } = require('./docs-claims/facts.cjs');
const { RULES } = require('./docs-claims/rules/index.cjs');
const { scanFiles } = require('./docs-claims/scan.cjs');

// Fails when the documentation claims something the repository can prove false.
// The July 2026 audit found the project's central problem was not wrong facts but
// outlived ones: a claim was written in more places than the fact was, so when the
// fact moved, the copies stayed. Every rule here compares prose against a fact the
// repository already holds, and none of them may hold a fact of their own.
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const ruleIndex = args.indexOf('--rule');
const onlyRule = ruleIndex === -1 ? null : args[ruleIndex + 1];

const selected = onlyRule ? RULES.filter((rule) => rule.id === onlyRule) : RULES;
if (onlyRule && selected.length === 0) {
  process.stderr.write(`Unknown rule "${onlyRule}". Known: ${RULES.map((rule) => rule.id).join(', ')}\n`);
  process.exit(2);
}

const facts = collectFacts(repoRoot);
const files = scanFiles(repoRoot);

const findings = [];
for (const rule of selected) {
  // A rule may decline a file whose genre makes its matches meaningless — dated
  // narration of what was true then, rather than a claim about what is true now.
  // This is scope, never a fact: no rule may exclude a file to hide a finding.
  const scoped = rule.skipPaths ? files.filter((file) => !rule.skipPaths.includes(file.path)) : files;
  for (const finding of rule.run({ facts, files: scoped })) {
    findings.push({ ...finding, rule: rule.id });
  }
}
findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);

if (asJson) {
  process.stdout.write(`${JSON.stringify({
    facts: { catalogApps: facts.packages.length, version: facts.version },
    filesScanned: files.length,
    findings,
    rules: selected.map((rule) => rule.id),
  }, null, 2)}\n`);
} else {
  process.stdout.write(`Checked ${files.length} files against ${selected.length} rule${selected.length === 1 ? '' : 's'} (MOS ${facts.version}, ${facts.packages.length} catalog apps).\n`);
  if (findings.length === 0) {
    process.stdout.write('No stale claims found.\n');
  } else {
    process.stdout.write('\n');
    for (const finding of findings) {
      process.stdout.write(`${finding.path}:${finding.line} — [${finding.rule}] ${finding.message}\n`);
    }
    process.stdout.write(`\n${findings.length} stale claim${findings.length === 1 ? '' : 's'}. Correct the documentation; there is deliberately no suppression mechanism.\n`);
  }
}

process.exit(findings.length === 0 ? 0 : 1);
