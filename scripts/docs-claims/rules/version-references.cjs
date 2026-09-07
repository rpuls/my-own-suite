// Only versions presented as *the current one*. "Added in MOS 0.18.0" and "a
// package that references it must set `minimumMosVersion` to `0.19.0`" are
// permanent facts about which release introduced something — they are correct
// forever and must never fire, which is why this matches currency claims rather
// than every version-shaped string it can find.
const CURRENCY_PATTERNS = [
  /\b(?:current|latest|newest)\s+(?:stable\s+)?(?:MOS\s+|My Own Suite\s+)?(?:release|version)\s*(?:is\s*|:\s*)?v?(\d+\.\d+\.\d+)/giu,
  /\b(?:MOS|My Own Suite)\s+v?(\d+\.\d+\.\d+)\s+is\s+(?:the\s+)?(?:current|latest|newest)\b/giu,
  /releases\/tag\/v(\d+\.\d+\.\d+)/giu,
  /\b(?:download|install|upgrade to)\s+(?:MOS\s+|My Own Suite\s+)?v(\d+\.\d+\.\d+)/giu,
];

module.exports = {
  id: 'version-references',
  title: 'A version presented as current matches VERSION',
  run({ facts, files }) {
    const findings = [];

    for (const file of files) {
      for (const line of file.lines) {
        if (line.inCode) continue;
        for (const pattern of CURRENCY_PATTERNS) {
          pattern.lastIndex = 0;
          let match = pattern.exec(line.text);
          while (match) {
            if (match[1] !== facts.version) {
              findings.push({
                line: line.number,
                message: `presents ${match[1]} as the current version, but VERSION is ${facts.version}`,
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
