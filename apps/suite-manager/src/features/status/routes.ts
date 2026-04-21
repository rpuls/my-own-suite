import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { OnboardingService } from '../onboarding/main/service.ts';
import { UpdatesService } from '../updates/service.ts';

export function createStatusRouter(
  config: SuiteManagerConfig,
  onboardingService: OnboardingService,
): Hono {
  const router = new Hono();
  const updatesService = new UpdatesService(config);

  router.get('/status', async (c) => {
    const updates = await updatesService.getStatus();

    return c.json({
      appUrls: config.appUrls,
      checkIntervalMs: config.checkIntervalMs,
      homepageUrl: config.homepageUrl,
      latestVersion: updates.latestRelease.version,
      setupBasePath: config.setupBasePath,
      onboardingStatePath: onboardingService.getStateFilePath(),
      ownerEmail: config.ownerEmail,
      ownerName: config.ownerName,
      service: 'suite-manager',
      status: 'ok',
      updateAvailable: updates.updateAvailable,
      version: updates.installedVersion,
    });
  });

  return router;
}
