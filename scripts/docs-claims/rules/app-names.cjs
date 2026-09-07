const APP_LINK = /\/docs\/apps\/([a-z0-9][a-z0-9-]*)\/?/giu;

// The docs app index builds one link per catalog entry at build time, so the
// links exist but the ids never appear as text. A page that interpolates an id
// into the path is therefore linking every app there is, and a rule that only
// reads literal text would otherwise report the whole catalog as unlinked.
const GENERATED_APP_LINK = /\/docs\/apps\/\$\{/u;

module.exports = {
  id: 'app-names',
  title: 'App docs links resolve to catalog packages, and every package is linked',
  run({ facts, files }) {
    const findings = [];
    const known = new Set(facts.packages.map((entry) => entry.id));
    const linked = new Set();
    let generatesEveryAppLink = false;

    for (const file of files) {
      for (const line of file.lines) {
        if (line.inCode) continue;
        if (GENERATED_APP_LINK.test(line.text)) generatesEveryAppLink = true;
        APP_LINK.lastIndex = 0;
        let match = APP_LINK.exec(line.text);
        while (match) {
          const id = match[1];
          linked.add(id);
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

    // The other direction: a package nothing links to is a page readers cannot
    // reach from anywhere, which is how an app quietly stops being documented.
    for (const entry of facts.packages) {
      if (!generatesEveryAppLink && !linked.has(entry.id)) {
        findings.push({
          line: 1,
          message: `${entry.name} (${entry.id}) is in the catalog but no scanned page links to /docs/apps/${entry.id}/`,
          path: 'apps/catalog.json',
        });
      }
    }

    return findings;
  },
};
