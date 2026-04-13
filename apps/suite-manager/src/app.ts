import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import type { SuiteManagerConfig } from './config.ts';
import { AuthService } from './features/auth/service.ts';
import { createAuthRouter } from './features/auth/routes.ts';
import { requireApiSession } from './features/auth/middleware.ts';
import { createHealthRouter } from './features/health/routes.ts';
import { createHomepageProxyRouter } from './features/homepage/proxy.ts';
import { createOnboardingRouter } from './features/onboarding/main/routes.ts';
import { OnboardingService } from './features/onboarding/main/service.ts';
import {
  getFrontendStaticRoot,
  hasBuiltFrontend,
  renderFrontendHtml,
} from './features/setup/frontend.ts';
import { createStatusRouter } from './features/status/routes.ts';
import { createUpdatesRouter } from './features/updates/routes.ts';
import { UpdatesService } from './features/updates/service.ts';

export function createApp(
  config: SuiteManagerConfig,
  onboardingService: OnboardingService,
): Hono {
  const app = new Hono();
  const authService = new AuthService(config);
  const updatesService = new UpdatesService(config);
  const setupApiPath = `${config.setupBasePath}/api`;
  const frontendReady = hasBuiltFrontend();

  app.route('/', createHealthRouter(config));
  app.route(`${setupApiPath}/auth`, createAuthRouter(config, authService));

  const protectedSetupApi = new Hono();
  protectedSetupApi.use('*', requireApiSession(config));
  protectedSetupApi.route('/onboarding', createOnboardingRouter(config, onboardingService));
  protectedSetupApi.route('/', createUpdatesRouter(updatesService));
  protectedSetupApi.route('/', createStatusRouter(config, onboardingService));
  app.route(setupApiPath, protectedSetupApi);

  if (frontendReady) {
    app.use(
      `${config.setupBasePath}/assets/*`,
      serveStatic({
        rewriteRequestPath: (requestPath) => requestPath.replace(config.setupBasePath, ''),
        root: getFrontendStaticRoot(),
      }),
    );
    app.use(
      `${config.setupBasePath}/vite.svg`,
      serveStatic({
        rewriteRequestPath: () => '/vite.svg',
        root: getFrontendStaticRoot(),
      }),
    );
    app.use(
      `${config.setupBasePath}/brand/*`,
      serveStatic({
        rewriteRequestPath: (requestPath) => requestPath.replace(config.setupBasePath, ''),
        root: getFrontendStaticRoot(),
      }),
    );
    app.use(
      `${config.setupBasePath}/site.webmanifest`,
      serveStatic({
        rewriteRequestPath: () => '/site.webmanifest',
        root: getFrontendStaticRoot(),
      }),
    );
  }

  app.get(config.setupBasePath, (c) => c.redirect(`${config.setupBasePath}/`, 302));
  app.get(`${config.setupBasePath}/*`, (c) => {
    if (!frontendReady) {
      return c.html(
        '<!doctype html><html><body><p>Suite Manager frontend is not built yet. Run `npm run build:client` or `npm run dev:client`.</p></body></html>',
      );
    }

    return c.html(renderFrontendHtml(config.setupBasePath));
  });
  app.route('/', createHomepageProxyRouter(config));
  app.notFound((c) => c.json({ error: 'Not found.' }, 404));

  return app;
}
