import { Hono } from 'hono';

import { UpdatesService } from './service.ts';

export function createUpdatesRouter(updatesService: UpdatesService): Hono {
  const router = new Hono();

  router.get('/updates', async (c) => {
    const status = await updatesService.getStatus();
    return c.json(status);
  });

  router.post('/updates/apply', async (c) => {
    try {
      const result = await updatesService.startManagedUpdate();
      return c.json(result, 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to start update.' },
        409,
      );
    }
  });

  router.post('/updates/track', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { track?: string };
      if (body.track !== 'stable' && body.track !== 'staging') {
        return c.json({ error: 'Update track must be stable or staging.' }, 400);
      }

      const status = await updatesService.configureTrack(body.track);
      return c.json(status);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to switch update track.' },
        409,
      );
    }
  });

  return router;
}
