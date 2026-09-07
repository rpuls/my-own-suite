const WORD_NUMBERS = {
  eight: 8,
  eighteen: 18,
  eleven: 11,
  fifteen: 15,
  five: 5,
  four: 4,
  fourteen: 14,
  nine: 9,
  nineteen: 19,
  one: 1,
  seven: 7,
  seventeen: 17,
  six: 6,
  sixteen: 16,
  ten: 10,
  thirteen: 13,
  three: 3,
  twelve: 12,
  twenty: 20,
  two: 2,
};

const NUMBER = `\\d+|${Object.keys(WORD_NUMBERS).join('|')}`;

// Only phrasings that tie a number to the catalog itself. "Install two apps" is
// advice, not a claim about how many exist, and a rule that fires on it would be
// ignored within a week.
const PATTERNS = [
  new RegExp(`\\b(${NUMBER})\\s+(?:official|catalog|curated|reviewed|available)\\s+apps?\\b`, 'giu'),
  new RegExp(`\\b(${NUMBER})\\s+apps?\\s+(?:in|from)\\s+the\\s+catalog\\b`, 'giu'),
  new RegExp(`\\bcatalog\\s+(?:of|has|have|contains?|includes?|carries|offers?|ships?\\s+with)\\s+(?:just\\s+|only\\s+)?(${NUMBER})\\s+apps?\\b`, 'giu'),
];

function toNumber(token) {
  const lowered = token.toLowerCase();
  return Object.hasOwn(WORD_NUMBERS, lowered) ? WORD_NUMBERS[lowered] : Number(lowered);
}

module.exports = {
  id: 'app-count',
  // Dated decision entries narrate what was true when they were written — "a
  // privacy review to all six catalog apps" is an accurate account of a past
  // migration, and correcting it to today's number would falsify the record.
  skipPaths: ['docs/decisions.md'],
  title: 'A stated number of catalog apps matches the catalog',
  run({ facts, files }) {
    const findings = [];
    const expected = facts.packages.length;

    for (const file of files) {
      for (const line of file.lines) {
        if (line.inCode) continue;
        for (const pattern of PATTERNS) {
          pattern.lastIndex = 0;
          let match = pattern.exec(line.text);
          while (match) {
            const claimed = toNumber(match[1]);
            if (claimed !== expected) {
              findings.push({
                line: line.number,
                message: `claims ${match[0].trim()}, but the catalog holds ${expected} apps`,
                path: file.path,
              });
            }
            match = pattern.exec(line.text);
          }
        }
      }
    }
    return findings;
  },
};
