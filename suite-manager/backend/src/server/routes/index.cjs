const { addressRoutes } = require('./address.cjs');
const { backupRoutes } = require('./backups.cjs');
const { smtpRoutes } = require('./smtp.cjs');
const { supportRoutes } = require('./support.cjs');
const { updateRoutes } = require('./updates.cjs');

// Every Suite Manager API route, in the order they are matched.
function routeTable(services) {
  return [
    ...addressRoutes(services),
    ...smtpRoutes(services),
    ...updateRoutes(services),
    ...backupRoutes(services),
    ...supportRoutes(services),
  ];
}

module.exports = { routeTable };
