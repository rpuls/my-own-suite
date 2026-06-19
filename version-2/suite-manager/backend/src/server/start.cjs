#!/usr/bin/env node

const path = require('node:path');

const { createV2Server } = require('./http-app.cjs');

const port = Number(process.env.PORT || process.env.MOS_V2_SUITE_MANAGER_PORT || '3100');
const host = process.env.HOST || process.env.MOS_V2_SUITE_MANAGER_HOST || '127.0.0.1';
const stateDir = process.env.MOS_V2_STATE_DIR || path.resolve(process.cwd(), '.state');
const frontendDistDir = process.env.MOS_V2_FRONTEND_DIST_DIR
  || path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');

const server = createV2Server({
  frontendDistDir,
  stateDir,
});

server.listen(port, host, () => {
  console.log(`[mos-v2-suite-manager] Listening on http://${host}:${port}`);
  console.log(`[mos-v2-suite-manager] State directory: ${stateDir}`);
});

function shutdown(signal) {
  console.log(`[mos-v2-suite-manager] Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
