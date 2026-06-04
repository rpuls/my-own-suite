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
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
        normalized,
      ),
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
      localHttpsApplyAvailable: serviceCapabilities.localHttpsApplyAvailable,
      realDomain,
      selfHostFeaturesAvailable: serviceCapabilities.serviceAvailable,
      tlsMode: config.tlsMode,
      urlScheme: config.urlScheme,
    });
  });

  router.post('/settings/local-https/apply', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON.' }, 400);
    }

    const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
    const acmeEmail = typeof input.acmeEmail === 'string' ? input.acmeEmail.trim() : '';
    const cloudflareApiToken =
      typeof input.cloudflareApiToken === 'string' ? input.cloudflareApiToken.trim() : '';

    if (!isRealAcmeDomain(domain)) {
      return c.json({ error: 'Enter a real Cloudflare-managed domain, such as mos.example.com.' }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(acmeEmail)) {
      return c.json({ error: 'Enter a valid ACME contact email address.' }, 400);
    }

    if (!cloudflareApiToken) {
      return c.json({ error: 'Cloudflare API token is required.' }, 400);
    }

    try {
      return c.json(await serviceAgentService.applyLocalHttps({ acmeEmail, cloudflareApiToken, domain }), 202);
    } catch (caughtError) {
      return c.json(
        { error: caughtError instanceof Error ? caughtError.message : 'Unable to apply local HTTPS settings.' },
        500,
      );
    }
  });

  return router;
}
