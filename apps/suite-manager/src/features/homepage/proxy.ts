import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { hasSession } from '../auth/middleware.ts';

function buildUpstreamUrl(config: SuiteManagerConfig, requestUrl: URL): string {
  const upstreamUrl = new URL(config.homepageUrl);
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;
  return upstreamUrl.toString();
}

export function createHomepageProxyRouter(config: SuiteManagerConfig): Hono {
  const router = new Hono();

  router.all('*', async (c) => {
    if (!hasSession(config, c)) {
      return c.redirect(`${config.setupBasePath}/`, 302);
    }

    const requestUrl = new URL(c.req.url);
    const homepagePublicUrl = new URL(config.appUrls.homepage);
    const headers = new Headers(c.req.raw.headers);
    const origin = headers.get('origin');
    const referer = headers.get('referer');
    headers.set('host', homepagePublicUrl.host);
    headers.set('x-forwarded-host', homepagePublicUrl.host);
    headers.set('x-forwarded-proto', homepagePublicUrl.protocol.replace(':', ''));
    headers.set('x-mos-original-host', requestUrl.host);

    if (origin) {
      const originUrl = new URL(origin);
      originUrl.protocol = homepagePublicUrl.protocol;
      originUrl.host = homepagePublicUrl.host;
      headers.set('origin', originUrl.toString().replace(/\/$/, ''));
    }

    if (referer) {
      const refererUrl = new URL(referer);
      refererUrl.protocol = homepagePublicUrl.protocol;
      refererUrl.host = homepagePublicUrl.host;
      headers.set('referer', refererUrl.toString());
    }

    const requestInit: RequestInit & { duplex?: 'half' } = {
      body:
        c.req.method === 'GET' || c.req.method === 'HEAD'
          ? undefined
          : (c.req.raw.body as ReadableStream<Uint8Array> | null),
      headers,
      method: c.req.method,
      redirect: 'manual',
    };

    if (requestInit.body) {
      requestInit.duplex = 'half';
    }

    const upstreamResponse = await fetch(buildUpstreamUrl(config, requestUrl), requestInit);
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    return new Response(upstreamResponse.body, {
      headers: responseHeaders,
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
    });
  });

  return router;
}
