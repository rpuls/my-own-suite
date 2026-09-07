// A promise with a tracked commitment behind it is a commitment. A promise
// without one is where the July 2026 audit's findings came from: copy that
// outlived the intention, with nothing anywhere to say whether it still held.
const ISSUE_LINK = /github\.com\/[^\s)"']+\/issues\/\d+/iu;

// Prose that quotes a promise is reporting one, not making one — the roadmap
// says three site spots promise a video as "on the way", and that sentence is
// the tracking, not the drift.
function isQuoted(text, index, length) {
  const before = text.slice(0, index);
  const after = text.slice(index + length);
  return /["“‘']\s*$/u.test(before) && /^\s*["”’']/u.test(after);
}

// Each phrase is matched only where it is actually a promise about availability.
// "one backup shortly after starting" and "redacted on the way in" are timing and
// direction; a rule that fired on those would be noise, and noise gets ignored.
const PROMISES = [
  { label: 'coming soon', pattern: /\bcoming soon\b/giu },
  { label: 'planned', pattern: /\b(?:is|are|remains?|stays?)\s+planned\b/giu },
  { label: 'planned', pattern: /(?:^\s*(?:[-*+]\s+)?|>\s*)planned\b(?!\s+(?:maintenance|outage|downtime|work))/gimu },
  { label: 'on the way', pattern: /\bon the way\b(?!\s+(?:in|out|back|to|through|up|down|here|there))/giu },
  { label: 'shortly', pattern: /\b(?:coming|available|arriving|landing|shipping|shipped|released?)\s+shortly\b/giu },
];

module.exports = {
  id: 'promised-soon',
  title: 'A promise of future work links to the issue tracking it',
  run({ files }) {
    const findings = [];

    for (const file of files) {
      for (const line of file.lines) {
        if (line.inCode || ISSUE_LINK.test(line.text)) continue;
        for (const promise of PROMISES) {
          promise.pattern.lastIndex = 0;
          const match = promise.pattern.exec(line.text);
          if (match && !isQuoted(line.text, match.index, match[0].length)) {
            findings.push({
              line: line.number,
              message: `promises "${promise.label}" with no GitHub issue linked on the same line`,
              path: file.path,
            });
            break;
          }
        }
      }
    }
    return findings;
  },
};
