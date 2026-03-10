import { serve } from '@hono/node-server';
import process from 'node:process';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { HomepageHealthMonitor } from './features/health/monitor.ts';
import { OnboardingService } from './features/onboarding/main/service.ts';
import { OnboardingStateStore } from './features/onboarding/shared/state-store.ts';
import { VaultwardenObserver } from './features/onboarding/vaultwarden/observer.ts';
import { log } from './lib/logger.ts';

const config = loadConfig();
const stateStore = new OnboardingStateStore(config.stateDir);
const vaultwardenObserver = new VaultwardenObserver(config.vaultwardenDatabaseUrl, config.ownerEmail);
const onboardingService = new OnboardingService(config, stateStore, vaultwardenObserver);
const healthMonitor = new HomepageHealthMonitor(
  config.homepageUrl,
  config.requestTimeoutMs,
  config.checkIntervalMs,
);
const app = createApp(config, onboardingService);

const server = serve({
  fetch: app.fetch,
  port: config.port,
});

log(`Suite Manager listening on port ${config.port}`);
log(`Homepage target ${config.homepageUrl}`);
log(`Homepage check interval ${config.checkIntervalMs}ms`);

void (async () => {
  await healthMonitor.runCheck();

  if (config.runOnce) {
    log('SUITE_MANAGER_RUN_ONCE enabled, exiting after initial check');
    server.close(() => process.exit());
    return;
  }

  healthMonitor.start();
})();

function shutdown(signal: string): void {
  log(`Received ${signal}, shutting down`);
  healthMonitor.stop();
  server.close((error) => {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`HTTP server close error: ${message}`);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
