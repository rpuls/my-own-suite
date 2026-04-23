import { Hono } from 'hono';

import { UpdatesService } from './service.ts';

export function createUpdatesRouter(updatesService: UpdatesService): Hono {
  const router = new Hono();

  router.get('/updates', async (c) => {
    const status = await updatesService.getStatus();
    return c.json(status);
  });

  router.post('/updates/apply', async (c) => {
    const status = await updatesService.getStatus();
    if (status.mode !== 'managed' || !status.serviceAvailable) {
      return c.json({ error: 'Managed update service is unavailable.' }, 409);
    }

    const result = await updatesService.startManagedUpdate();
    return c.json(result, 202);
  });

  return router;
}
