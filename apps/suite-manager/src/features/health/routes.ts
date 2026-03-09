import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';

export function createHealthRouter(config: SuiteManagerConfig): Hono {
  const router = new Hono();

  router.get('/healthz', (c) =>
    c.json({
      service: 'suite-manager',
      status: 'ok',
      homepageUrl: config.homepageUrl,
      checkIntervalMs: config.checkIntervalMs,
    }),
  );

  return router;
}
