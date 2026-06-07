import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import type { ServiceAgentService } from '../service-agent/service.ts';
import { HomepageConfigService, type HomepageExternalServicesResult } from './service.ts';

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

  async function refreshExternalServices(
    servicesResult: HomepageExternalServicesResult,
  ): Promise<
    HomepageExternalServicesResult & {
      externalLinksUpdated: boolean;
      homepageRestarted: boolean;
      warning: string | null;
    }
  > {
    const capabilities = await serviceAgentService.getCapabilities();
    const warnings: string[] = [];
    let externalLinksUpdated = false;
    let homepageRestarted = false;

    if (capabilities.caddyExternalProxyApplyAvailable) {
      try {
        const preview = await homepageConfigService.getCaddyProxyPreview();
        if (preview.valid) {
          await serviceAgentService.applyCaddyExternalProxies(preview.caddyfile);
          externalLinksUpdated = true;
        }
      } catch (caughtError) {
        warnings.push(
          caughtError instanceof Error
            ? `External service links could not be updated: ${caughtError.message}`
            : 'External service links could not be updated.',
        );
      }
    }

    if (capabilities.homepageRestartAvailable) {
      try {
        await serviceAgentService.restartHomepage();
        homepageRestarted = true;
      } catch (caughtError) {
        warnings.push(
          caughtError instanceof Error
            ? `Homepage could not be restarted: ${caughtError.message}`
            : 'Homepage could not be restarted.',
        );
      }
    }

    return {
      ...servicesResult,
      externalLinksUpdated,
      homepageRestarted,
      warning: warnings.length > 0 ? warnings.join(' ') : null,
    };
  }

  router.get('/homepage-config/external-services', async (c) => {
    try {
      return c.json(await homepageConfigService.listExternalServices());
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to load external services.' },
        400,
      );
    }
  });

  router.post('/homepage-config/external-services', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) || {};
      return c.json(await refreshExternalServices(await homepageConfigService.addExternalService(body)), 201);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to add external service.' },
        400,
      );
    }
  });

  router.put('/homepage-config/external-services/:id', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) || {};
      return c.json(
        await refreshExternalServices(
          await homepageConfigService.updateExternalService(c.req.param('id'), body),
        ),
      );
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to update external service.' },
        400,
      );
    }
  });

  router.delete('/homepage-config/external-services/:id', async (c) => {
    try {
      return c.json(
        await refreshExternalServices(await homepageConfigService.removeExternalService(c.req.param('id'))),
      );
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to remove external service.' },
        400,
      );
    }
  });

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

  router.post('/homepage-config/caddy-preview/apply', async (c) => {
    try {
      const preview = await homepageConfigService.getCaddyProxyPreview();
      if (!preview.valid) {
        return c.json({ error: 'Cannot apply invalid Caddy proxy config.', preview }, 400);
      }

      const result = await serviceAgentService.applyCaddyExternalProxies(preview.caddyfile);
      return c.json({ ...result, preview }, 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to apply Caddy proxy config.' },
        409,
      );
    }
  });

  router.post('/homepage-config/files/:name/validate', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
      if (!body || typeof body.content !== 'string') {
        return c.json({ error: 'Config content is required.' }, 400);
      }

      return c.json(homepageConfigService.validateFileContent(c.req.param('name'), body.content));
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to validate Homepage config.' },
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
