const APP_LINK = /\/docs\/apps\/([a-z0-9][a-z0-9-]*)\/?/giu;

// One direction only. The reverse — a package no page links to — cannot happen
// by construction: the docs app index and the per-app pages are both generated
// from the same `apps/*/manifest.json` glob this rule's facts come from, so
// every package has a page and a card whether or not any prose names it. A
// check for it here would guard nothing, and the first version of this rule did
// exactly that while claiming otherwise.
module.exports = {
  id: 'app-names',
  title: 'App docs links resolve to catalog packages',
  run({ facts, files }) {
    const findings = [];
    const known = new Set(facts.packages.map((entry) => entry.id));

    for (const file of files) {
      for (const line of file.lines) {
        if (line.inCode) continue;
        APP_LINK.lastIndex = 0;
        let match = APP_LINK.exec(line.text);
        while (match) {
          const id = match[1];
          if (!known.has(id)) {
            findings.push({
              line: line.number,
              message: `links to /docs/apps/${id}/, which is not a package in the catalog`,
              path: file.path,
            });
          }
          match = APP_LINK.exec(line.text);
        }
      }
    }

    return findings;
  },
};
