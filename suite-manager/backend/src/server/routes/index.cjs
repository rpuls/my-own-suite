const { backupRoutes } = require('./backups.cjs');
const { smtpRoutes } = require('./smtp.cjs');
const { updateRoutes } = require('./updates.cjs');

// Every Suite Manager API route, in the order they are matched.
function routeTable(services) {
  return [
    ...smtpRoutes(services),
    ...updateRoutes(services),
    ...backupRoutes(services),
  ];
}

module.exports = { routeTable };
