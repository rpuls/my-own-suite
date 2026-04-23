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

  return router;
}
