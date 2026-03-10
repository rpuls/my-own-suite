import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../../config.ts';
import { buildVaultwardenImportCsv } from '../vaultwarden/import-handoff.ts';
import { isAuthorized } from '../shared/auth.ts';
import { OnboardingService } from './service.ts';

export function createOnboardingRouter(
  config: SuiteManagerConfig,
  onboardingService: OnboardingService,
): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    const authorized = isAuthorized(c, config.bootstrapToken);
    return onboardingService.buildModel(authorized).then((model) => c.json(model));
  });

  router.post('/actions/:actionId', async (c) => {
    if (!isAuthorized(c, config.bootstrapToken)) {
      return c.json({ error: 'Bootstrap token required.' }, 401);
    }

    const actionId = c.req.param('actionId');
    try {
      onboardingService.triggerAction(actionId);
      return c.json({ actionId, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown action.';
      return c.json({ error: message }, 404);
    }
  });

  router.get('/imports/vaultwarden.csv', (c) => {
    if (!isAuthorized(c, config.bootstrapToken)) {
      return c.json({ error: 'Bootstrap token required.' }, 401);
    }

    const csv = buildVaultwardenImportCsv(config);

    return new Response(csv, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="my-own-suite-vaultwarden-import.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
      },
      status: 200,
    });
  });

  return router;
}
