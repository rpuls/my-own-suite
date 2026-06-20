import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './support/global-setup.mjs',
  globalTeardown: './support/global-teardown.mjs',
  use: {
    baseURL: 'http://home.127.0.0.1.sslip.io:13100',
    headless: process.env.MOS_V2_E2E_HEADED !== '1',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
