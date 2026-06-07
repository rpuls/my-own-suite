import { Hono } from 'hono';

import { BackupsService } from './service.ts';

export function createBackupsRouter(backupsService: BackupsService): Hono {
  const router = new Hono();

  router.get('/backups', async (c) => {
    const status = await backupsService.getStatus();
    return c.json(status);
  });

  router.post('/backups/start', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { destinationId?: string };
      const result = await backupsService.startBackup((body.destinationId || '').trim());
      return c.json(result, 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to start backup.' },
        409,
      );
    }
  });

  router.post('/backups/mount', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { destinationId?: string };
      const result = await backupsService.mountDestination((body.destinationId || '').trim());
      return c.json(result);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to mount drive.' },
        409,
      );
    }
  });

  router.post('/backups/restore', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { backupPath?: string; confirmation?: string };
      const result = await backupsService.startRestore((body.backupPath || '').trim(), (body.confirmation || '').trim());
      return c.json(result, 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to start restore.' },
        409,
      );
    }
  });

  return router;
}
