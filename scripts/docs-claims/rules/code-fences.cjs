const { unclosedFenceLine } = require('../scan.cjs');

// Not a claim check but the guard for all of them: every other rule skips
// fenced code, so a fence that never closes silences the rest of the file.
module.exports = {
  id: 'code-fences',
  title: 'Every code fence closes, so no claim after one is hidden from these checks',
  run({ files }) {
    const findings = [];
    for (const file of files) {
      const line = unclosedFenceLine(file.text);
      if (line !== null) {
        findings.push({
          line,
          message: 'opens a code fence that never closes, which hides every claim after it from these checks',
          path: file.path,
        });
      }
    }
    return findings;
  },
};
