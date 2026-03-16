import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 180000,
  expect: {
    timeout: 15000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never' }]],
  retries: process.env.CI ? 1 : 0,
  globalSetup: './support/global-setup.js',
  globalTeardown: './support/global-teardown.js',
  use: {
    baseURL: 'http://suite-manager.localhost:18080',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
