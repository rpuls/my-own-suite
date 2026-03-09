import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { OnboardingService } from '../onboarding/service.ts';

export function createStatusRouter(
  config: SuiteManagerConfig,
  onboardingService: OnboardingService,
): Hono {
  const router = new Hono();

  router.get('/status', (c) =>
    c.json({
      appUrls: config.appUrls,
      checkIntervalMs: config.checkIntervalMs,
      homepageUrl: config.homepageUrl,
      onboardingStatePath: onboardingService.getStateFilePath(),
      ownerEmail: config.ownerEmail,
      ownerName: config.ownerName,
      service: 'suite-manager',
      status: 'ok',
    }),
  );

  return router;
}
