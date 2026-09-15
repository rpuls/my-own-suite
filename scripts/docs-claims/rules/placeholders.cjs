// Markers, not the words. `docs/README.md` legitimately forbids "roadmap, TODO,
// backlog, or planning documents" in prose; firing on that sentence would teach
// everyone to stop reading this rule's output.
const MARKERS = [
  { label: 'TODO', pattern: /(?:^\s*(?:[-*+>]\s*)?|<!--\s*)TODO\b|\bTODO\s*[:(]/gmu },
  { label: 'FIXME', pattern: /(?:^\s*(?:[-*+>]\s*)?|<!--\s*)FIXME\b|\bFIXME\s*[:(]/gmu },
  { label: 'TBD', pattern: /(?:^\s*(?:[-*+>]\s*)?|<!--\s*)TBD\b|\bTBD\s*[:(]/gmu },
  { label: 'lorem ipsum', pattern: /\blorem ipsum\b/giu },
  { label: 'placeholder comment', pattern: /<!--\s*placeholder/giu },
];

module.exports = {
  id: 'placeholders',
  title: 'No placeholder markers survive in published prose',
  run({ files }) {
    const findings = [];

    for (const file of files) {
      for (const line of file.lines) {
        for (const marker of MARKERS) {
          marker.pattern.lastIndex = 0;
          if (marker.pattern.test(line.text)) {
            findings.push({
              line: line.number,
              message: `leaves a ${marker.label} marker in published prose`,
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
