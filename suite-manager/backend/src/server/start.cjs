#!/usr/bin/env node

const path = require('node:path');

const { createMOSServer } = require('./http-app.cjs');
const { createLogger } = require('./logger.cjs');

const port = Number(process.env.PORT || process.env.MOS_SUITE_MANAGER_PORT || '3100');
const host = process.env.HOST || process.env.MOS_SUITE_MANAGER_HOST || '127.0.0.1';
const homeHost = process.env.MOS_HOME_HOST || 'home.localhost';
const stateDir = process.env.MOS_STATE_DIR || path.resolve(process.cwd(), '.state');
const frontendDistDir = process.env.MOS_FRONTEND_DIST_DIR
  || path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');

const logger = createLogger();
const server = createMOSServer({ frontendDistDir, homeHost, logger, stateDir });

async function start() {
  const migrations = await server.migrateAppPackages();
  for (const migration of migrations) logger.info('app-package-migrated', { packageId: migration.packageId, status: migration.status });
  const recoveries = await server.recoverAppPackageUpdates();
  for (const recovery of recoveries) logger.info('app-update-recovered', { instanceId: recovery.instanceId, recoveryState: recovery.recoveryState });
  const dashboardLinks = await server.reconcileDashboardLinks();
  if (dashboardLinks.status !== 'skipped') logger.info('dashboard-links-reconciled', { errorCode: dashboardLinks.errorCode || undefined, status: dashboardLinks.status });
  const sweptCandidates = server.sweepAppCandidates();
  if (sweptCandidates.length) logger.info('app-candidates-reclaimed', { count: sweptCandidates.length });
  void server.startCatalogRefresh();
  server.listen(port, host, () => {
    logger.info('listening', {
      host,
      openUrl: `http://${homeHost}:${port}/suite-manager/`,
      port,
      stateDir,
    });
  });
}

start().catch((error) => {
  logger.error('start-failed', { error });
  process.exit(1);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('port-in-use', { hint: 'Set MOS_SUITE_MANAGER_PORT to choose another port.', port });
    process.exit(1);
  }

  logger.error('server-error', { error });
  process.exit(1);
});

// An uncaught rejection is the failure mode that takes the process down with no
// record of what threw; systemd restarts it and the reason is gone.
process.on('unhandledRejection', (error) => { logger.error('unhandled-rejection', { error }); });
process.on('uncaughtException', (error) => {
  logger.error('uncaught-exception', { error });
  process.exit(1);
});

function shutdown(signal) {
  logger.info('shutting-down', { signal });
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
