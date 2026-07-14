#!/usr/bin/env node

const path = require('node:path');

const { createV2Server } = require('./http-app.cjs');

const port = Number(process.env.PORT || process.env.MOS_V2_SUITE_MANAGER_PORT || '3100');
const host = process.env.HOST || process.env.MOS_V2_SUITE_MANAGER_HOST || '127.0.0.1';
const homeHost = process.env.MOS_V2_HOME_HOST || 'home.localhost';
const stateDir = process.env.MOS_V2_STATE_DIR || path.resolve(process.cwd(), '.state');
const frontendDistDir = process.env.MOS_V2_FRONTEND_DIST_DIR
  || path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');

const server = createV2Server({ frontendDistDir, homeHost, stateDir });

async function start() {
  const migrations = await server.migrateAppPackages();
  for (const migration of migrations) console.log(`[mos-v2-suite-manager] App package migration ${migration.packageId}: ${migration.status}`);
  server.listen(port, host, () => {
    console.log(`[mos-v2-suite-manager] Listening on http://${host}:${port}`);
    console.log(`[mos-v2-suite-manager] Open http://${homeHost}:${port}/suite-manager/`);
    console.log(`[mos-v2-suite-manager] State directory: ${stateDir}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[mos-v2-suite-manager] Port ${port} is already in use. Set MOS_V2_SUITE_MANAGER_PORT to choose another port.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[mos-v2-suite-manager] Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
