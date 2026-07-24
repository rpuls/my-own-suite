import { defineConfig } from '@playwright/test';

import { loadHypervEnv } from './support/hyperv-env.mjs';

const env = loadHypervEnv();

export default defineConfig({
  testDir: './specs',
  testMatch: /hyperv-full\.spec\.mjs/u,
  timeout: 30 * 60 * 1000,
  expect: { timeout: 30000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-hyperv' }]],
  use: {
    baseURL: env.baseURL,
    // Marketing screenshots harvested from this suite (support/screenshots.mjs)
    // need the same crisp 2x density as the site's existing assets, so the
    // whole run renders at a desktop viewport with a retina scale factor.
    deviceScaleFactor: 2,
    headless: process.env.MOS_E2E_HEADED !== '1',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { height: 900, width: 1440 },
  },
});
