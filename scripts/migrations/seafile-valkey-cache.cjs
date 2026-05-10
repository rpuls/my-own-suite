const path = require('node:path');

module.exports = {
  id: '2026-05-01-seafile-valkey-cache',
  migrate({ readEnvFile, setEnvValues, vpsDir }) {
    const seafileEnvPath = path.join(vpsDir, 'services', 'seafile', '.env');
    const seafileEnv = readEnvFile(seafileEnvPath);

    if (!seafileEnv) {
      return {
        changed: false,
        details: ['deploy/vps/services/seafile/.env does not exist yet'],
      };
    }

    const cacheProvider = (seafileEnv.CACHE_PROVIDER || '').trim().toLowerCase();
    const hasMemcachedSettings =
      cacheProvider === 'memcached' ||
      Object.prototype.hasOwnProperty.call(seafileEnv, 'MEMCACHED_HOST') ||
      Object.prototype.hasOwnProperty.call(seafileEnv, 'MEMCACHED_PORT');
    const missingRedisSettings =
      !Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_HOST') ||
      !Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_PORT') ||
      !Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_PASSWORD');

    if (cacheProvider === 'redis' && !hasMemcachedSettings && !missingRedisSettings) {
      return {
        changed: false,
        details: ['Seafile cache env already uses Redis-compatible settings'],
      };
    }

    const updates = {
      CACHE_PROVIDER: 'redis',
    };

    if (hasMemcachedSettings || !Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_HOST')) {
      updates.REDIS_HOST = 'valkey';
    }

    if (hasMemcachedSettings || !Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_PORT')) {
      updates.REDIS_PORT = '6379';
    }

    if (!Object.prototype.hasOwnProperty.call(seafileEnv, 'REDIS_PASSWORD')) {
      updates.REDIS_PASSWORD = '';
    }

    const changedKeys = setEnvValues(seafileEnvPath, updates);

    return {
      changed: changedKeys.length > 0,
      details:
        changedKeys.length > 0
          ? [`updated ${changedKeys.join(', ')} in deploy/vps/services/seafile/.env`]
          : ['Seafile cache env already matches Valkey settings'],
    };
  },
};
