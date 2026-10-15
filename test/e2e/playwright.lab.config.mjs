import path from 'node:path';

import { defineConfig } from '@playwright/test';

import { e2eRoot, loadEnv } from './support/env.mjs';

const env = loadEnv();
const runId = process.env.MOS_E2E_RUN_ID || 'adhoc';
const resultsDir = path.join(e2eRoot, 'results', runId);

// Run through `npm run e2e`, which resolves the path into results/<run>/plan.json.
export default defineConfig({
  testDir: './specs',
  testMatch: /path\.spec\.mjs/u,
  outputDir: path.join(resultsDir, 'playwright'),
  timeout: 0,
  expect: { timeout: 30000 },
  workers: 1,
  fullyParallel: false,
  reporter: [
    [path.join(e2eRoot, 'support', 'path-reporter.mjs'), { resultsDir }],
    ['html', { open: 'never', outputFolder: path.join(resultsDir, 'report') }],
  ],
  use: {
    // A click on something that never appears fails here, not at the end of the step's budget.
    actionTimeout: 45000,
    navigationTimeout: 90000,
    baseURL: env.baseURL,
    // The public site's screenshots are harvested from these runs and need the
    // site's 2x density, so every run renders at a desktop retina viewport.
    deviceScaleFactor: 2,
    headless: process.env.MOS_E2E_HEADED !== '1',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { height: 900, width: 1440 },
  },
});
