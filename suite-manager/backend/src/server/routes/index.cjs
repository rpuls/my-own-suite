const { backupRoutes } = require('./backups.cjs');

// Every Suite Manager API route, in the order they are matched.
function routeTable(services) {
  return [
    ...backupRoutes(services),
  ];
}

module.exports = { routeTable };
