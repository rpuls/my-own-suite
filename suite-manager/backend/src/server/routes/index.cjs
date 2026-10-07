const { addressRoutes } = require('./address.cjs');
const { backupRoutes } = require('./backups.cjs');
const { customizeRoutes } = require('./customize.cjs');
const { labRoutes } = require('./lab.cjs');
const { settingsRoutes } = require('./settings.cjs');
const { smtpRoutes } = require('./smtp.cjs');
const { supportRoutes } = require('./support.cjs');
const { updateRoutes } = require('./updates.cjs');
const { vaultRoutes } = require('./vault.cjs');

// Every Suite Manager API route, in the order they are matched.
function routeTable(services) {
  return [
    ...labRoutes(services),
    ...settingsRoutes(services),
    ...vaultRoutes(services),
    ...addressRoutes(services),
    ...smtpRoutes(services),
    ...updateRoutes(services),
    ...backupRoutes(services),
    ...supportRoutes(services),
    ...customizeRoutes(services),
  ];
}

module.exports = { routeTable };
