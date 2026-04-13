import { Hono } from 'hono';

import { UpdatesService } from './service.ts';

export function createUpdatesRouter(updatesService: UpdatesService): Hono {
  const router = new Hono();

  router.get('/updates', async (c) => {
    const status = await updatesService.getStatus();
    return c.json(status);
  });

  return router;
}
