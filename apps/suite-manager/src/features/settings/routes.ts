import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import type { ServiceAgentService } from '../service-agent/service.ts';

function isRealAcmeDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  return Boolean(
    normalized &&
      normalized !== 'localhost' &&
      normalized !== 'mos.home' &&
      !normalized.endsWith('.localhost') &&
      !normalized.endsWith('.home') &&
      normalized.includes('.'),
  );
}

export function createSettingsRouter(config: SuiteManagerConfig, serviceAgentService: ServiceAgentService): Hono {
  const router = new Hono();

  router.get('/settings/local-https', async (c) => {
    const serviceCapabilities = await serviceAgentService.getCapabilities();
    const localHttpsReady = config.urlScheme === 'https' && config.tlsMode === 'cloudflare-dns01';
    const realDomain = isRealAcmeDomain(config.domain);

    return c.json({
      currentUrls: {
        homepage: `${config.urlScheme}://homepage.${config.domain}`,
        suiteManager: config.appUrls.suiteManager,
      },
      domain: config.domain,
      localHttpsReady,
      realDomain,
      selfHostFeaturesAvailable: serviceCapabilities.serviceAvailable,
      tlsMode: config.tlsMode,
      urlScheme: config.urlScheme,
    });
  });

  return router;
}
