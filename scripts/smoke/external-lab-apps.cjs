const { EXTERNAL_ROUTE_HOST_PREFIX } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');

// External packages the Hyper-V lab must be able to reach.
//
// Official apps are discoverable: the lab scans `apps/*/manifest.json` and reads
// their route hosts straight from the package. External packages are not in this
// repository at all — they are installed at runtime from a GitHub repo the lab has
// never seen — so the lab cannot discover them and they must be declared here.
//
// `routeHosts` mirrors the `routes[].host` values published in the external
// package's own `.mos/manifest.json`. It is a fixture: if the published package
// renames a route, update this list. The `ext-` prefix is deliberately NOT written
// here — it is imported from the package contract above, so the lab keeps resolving
// the right names if that prefix ever changes.
const EXTERNAL_LAB_APPS = [
  {
    id: 'example-notes',
    repository: 'https://github.com/rpuls/MOS-external-app-example',
    routeHosts: ['notes'],
  },
];

// The hostname labels an external lab app is actually served at, e.g. `ext-notes`.
function externalLabRouteHosts() {
  return EXTERNAL_LAB_APPS.flatMap((app) => app.routeHosts.map((host) => `${EXTERNAL_ROUTE_HOST_PREFIX}${host}`));
}

module.exports = { EXTERNAL_LAB_APPS, externalLabRouteHosts };

// Printed one per line so the PowerShell lab harness can consume them without
// teaching PowerShell how the `ext-` prefix works.
if (require.main === module) {
  const hosts = externalLabRouteHosts();
  process.stdout.write(hosts.length ? `${hosts.join('\n')}\n` : '');
}
