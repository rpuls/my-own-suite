import fs from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import type { SuiteManagerConfig } from './config.ts';
import { createHealthRouter } from './features/health/routes.ts';
import { createOnboardingRouter } from './features/onboarding/main/routes.ts';
import { OnboardingService } from './features/onboarding/main/service.ts';
import { createStatusRouter } from './features/status/routes.ts';
export function createApp(
  config: SuiteManagerConfig,
  onboardingService: OnboardingService,
): Hono {
  const app = new Hono();
  const frontendDistRoot = './frontend/dist';
  const frontendIndexPath = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  const hasBuiltFrontend = fs.existsSync(frontendIndexPath);

  app.route('/', createHealthRouter(config));
  app.route('/api/onboarding', createOnboardingRouter(config, onboardingService));
  app.route('/api', createStatusRouter(config, onboardingService));
  if (hasBuiltFrontend) {
    app.use('/assets/*', serveStatic({ root: frontendDistRoot }));
    app.use('/vite.svg', serveStatic({ root: frontendDistRoot }));
  }
  app.get('*', (c) => {
    if (!hasBuiltFrontend) {
      return c.html(
        '<!doctype html><html><body><p>Suite Manager frontend is not built yet. Run `npm run build:client` or `npm run dev:client`.</p></body></html>',
      );
    }

    return c.html(fs.readFileSync(frontendIndexPath, 'utf8'));
  });
  app.notFound((c) => c.json({ error: 'Not found.' }, 404));

  return app;
}
