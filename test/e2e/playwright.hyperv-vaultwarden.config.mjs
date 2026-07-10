import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.hyperv.config.mjs';

export default defineConfig({
  ...baseConfig,
  testMatch: /hyperv-vaultwarden\.spec\.mjs/u,
});