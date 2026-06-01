import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import type { ServiceAgentService } from '../service-agent/service.ts';
import { HomepageConfigService } from './service.ts';

function hasSyncToken(config: SuiteManagerConfig, authorizationHeader: string | undefined): boolean {
  return Boolean(
    config.homepageConfigSyncToken && authorizationHeader === `Bearer ${config.homepageConfigSyncToken}`,
  );
}

export function createHomepageConfigRouter(
  homepageConfigService: HomepageConfigService,
  serviceAgentService: ServiceAgentService,
): Hono {
  const router = new Hono();

  router.get('/homepage-config', (c) => c.json({ files: homepageConfigService.listFiles() }));

  router.get('/homepage-config/capabilities', async (c) => c.json(await serviceAgentService.getCapabilities()));

  router.get('/homepage-config/caddy-preview', async (c) => {
    try {
      return c.json(await homepageConfigService.getCaddyProxyPreview());
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to preview Caddy proxy config.' },
        400,
      );
    }
  });

  router.post('/homepage-config/caddy-preview', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
      if (!body || typeof body.content !== 'string') {
        return c.json({ error: 'Config content is required.' }, 400);
      }

      return c.json(homepageConfigService.previewCaddyProxyContent(body.content));
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to preview Caddy proxy config.' },
        400,
      );
    }
  });

  router.get('/homepage-config/files/:name', async (c) => {
    try {
      const result = await homepageConfigService.readFile(c.req.param('name'));
      return c.json(result);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to read Homepage config.' },
        404,
      );
    }
  });

  router.put('/homepage-config/files/:name', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
      if (!body || typeof body.content !== 'string') {
        return c.json({ error: 'Config content is required.' }, 400);
      }

      const result = await homepageConfigService.writeFile(c.req.param('name'), body.content);
      return c.json(result);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to save Homepage config.' },
        400,
      );
    }
  });

  router.post('/homepage-config/files/:name/reset', async (c) => {
    try {
      const result = await homepageConfigService.resetFile(c.req.param('name'));
      return c.json(result);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to reset Homepage config.' },
        400,
      );
    }
  });

  router.post('/homepage-config/restart-homepage', async (c) => {
    try {
      return c.json(await serviceAgentService.restartHomepage(), 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to restart Homepage.' },
        409,
      );
    }
  });

  return router;
}

export function createHomepageConfigExportRouter(
  config: SuiteManagerConfig,
  homepageConfigService: HomepageConfigService,
): Hono {
  const router = new Hono();

  router.get('/homepage-config/export', async (c) => {
    if (!hasSyncToken(config, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized.' }, 401);
    }

    try {
      return c.json(await homepageConfigService.exportFiles());
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to export Homepage config.' },
        500,
      );
    }
  });

  return router;
}
