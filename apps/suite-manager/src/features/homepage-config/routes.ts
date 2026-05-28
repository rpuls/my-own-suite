import { Hono } from 'hono';

import { HomepageConfigService } from './service.ts';

export function createHomepageConfigRouter(homepageConfigService: HomepageConfigService): Hono {
  const router = new Hono();

  router.get('/homepage-config', (c) => c.json({ files: homepageConfigService.listFiles() }));

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

  return router;
}
