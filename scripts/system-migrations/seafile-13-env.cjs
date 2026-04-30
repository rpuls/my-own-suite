const path = require('node:path');

const id = 'seafile-13-env';
const description = 'Map Seafile 12 bootstrap env names to Seafile 13 bootstrap env names.';

function splitHostPort(value) {
  const [host = '', port = ''] = String(value || '').split(':');
  return { host, port };
}

function migrate(context) {
  const seafileEnvPath = path.join(context.vpsDir, 'services', 'seafile', '.env');
  const seafileMysqlEnvPath = path.join(context.vpsDir, 'services', 'seafile-mysql', '.env');
  const current = context.readEnvFile(seafileEnvPath);

  if (!current) {
    return { changed: false, details: ['deploy/vps/services/seafile/.env not found'] };
  }

  const mysqlCurrent = context.readEnvFile(seafileMysqlEnvPath) || {};
  const updates = {};
  const mysqlRootPassword = mysqlCurrent.MYSQL_ROOT_PASSWORD || '';
  const mappings = {
    DB_HOST: 'SEAFILE_MYSQL_DB_HOST',
    DB_PORT: 'SEAFILE_MYSQL_DB_PORT',
    DB_ROOT_PASSWD: 'INIT_SEAFILE_MYSQL_ROOT_PASSWORD',
    SEAFILE_ADMIN_EMAIL: 'INIT_SEAFILE_ADMIN_EMAIL',
    SEAFILE_ADMIN_PASSWORD: 'INIT_SEAFILE_ADMIN_PASSWORD',
  };

  for (const [legacyKey, nextKey] of Object.entries(mappings)) {
    if (current[legacyKey] && !current[nextKey]) {
      updates[nextKey] = current[legacyKey];
    }
  }

  if (
    mysqlRootPassword &&
    current.INIT_SEAFILE_MYSQL_ROOT_PASSWORD &&
    current.INIT_SEAFILE_MYSQL_ROOT_PASSWORD !== mysqlRootPassword
  ) {
    updates.INIT_SEAFILE_MYSQL_ROOT_PASSWORD = mysqlRootPassword;
  }

  if (current.MEMCACHED_SERVER && !current.MEMCACHED_HOST) {
    const { host, port } = splitHostPort(current.MEMCACHED_SERVER);
    if (host) {
      updates.MEMCACHED_HOST = host;
    }
    if (port && !current.MEMCACHED_PORT) {
      updates.MEMCACHED_PORT = port;
    }
  }

  if (Object.keys(updates).length === 0) {
    return { changed: false, details: ['no legacy Seafile env values needed migration'] };
  }

  context.appendEnvValues(seafileEnvPath, updates);
  return {
    changed: true,
    details: Object.keys(updates).map((key) => `set ${key}`),
  };
}

module.exports = {
  description,
  id,
  migrate,
};
