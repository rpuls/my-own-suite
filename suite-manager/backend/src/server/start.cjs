#!/usr/bin/env node

const path = require('node:path');

const { createMOSServer } = require('./http-app.cjs');

const port = Number(process.env.PORT || process.env.MOS_SUITE_MANAGER_PORT || '3100');
const host = process.env.HOST || process.env.MOS_SUITE_MANAGER_HOST || '127.0.0.1';
const homeHost = process.env.MOS_HOME_HOST || 'home.localhost';
const stateDir = process.env.MOS_STATE_DIR || path.resolve(process.cwd(), '.state');
const frontendDistDir = process.env.MOS_FRONTEND_DIST_DIR
  || path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');

const server = createMOSServer({ frontendDistDir, homeHost, stateDir });

async function start() {
  const migrations = await server.migrateAppPackages();
  for (const migration of migrations) console.log(`[mos-suite-manager] App package migration ${migration.packageId}: ${migration.status}`);
  const recoveries = await server.recoverAppPackageUpdates();
  for (const recovery of recoveries) console.log(`[mos-suite-manager] App update recovery ${recovery.instanceId}: ${recovery.recoveryState}`);
  const dashboardLinks = await server.reconcileDashboardLinks();
  if (dashboardLinks.status !== 'skipped') console.log(`[mos-suite-manager] Dashboard app links: ${dashboardLinks.status}${dashboardLinks.errorCode ? ` (${dashboardLinks.errorCode})` : ''}`);
  const sweptCandidates = server.sweepAppCandidates();
  if (sweptCandidates.length) console.log(`[mos-suite-manager] Reclaimed ${sweptCandidates.length} abandoned app package candidate download(s).`);
  void server.startCatalogRefresh();
  server.listen(port, host, () => {
    console.log(`[mos-suite-manager] Listening on http://${host}:${port}`);
    console.log(`[mos-suite-manager] Open http://${homeHost}:${port}/suite-manager/`);
    console.log(`[mos-suite-manager] State directory: ${stateDir}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[mos-suite-manager] Port ${port} is already in use. Set MOS_SUITE_MANAGER_PORT to choose another port.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[mos-suite-manager] Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
