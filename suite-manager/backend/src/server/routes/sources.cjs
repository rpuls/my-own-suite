const { withUnmetRequirements } = require('../../apps/host-requirements.cjs');
const { jsonResponse } = require('../responses.cjs');

const SOURCES = 'Sign in to manage app package sources.';

function sourceRoutes({ appPackages, externalSourceService }) {
  return [
    {
      method: 'GET',
      path: '/apps/sources',
      signIn: SOURCES,
      handler: async ({ response }) => {
        jsonResponse(response, 200, { sources: externalSourceService.listSources() });
      },
    },
    {
      method: 'POST',
      path: '/apps/sources',
      signIn: SOURCES,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 201, {
          source: await externalSourceService.addSource({
            catalogPath: input.catalogPath,
            kind: input.kind,
            publisher: input.publisher,
            repository: input.repository,
            signature: input.signature,
            trust: input.trust,
          }, { ref: typeof input.ref === 'string' && input.ref ? input.ref : 'main' }),
        });
      },
    },
    {
      method: 'POST',
      path: '/apps/sources/resolve',
      signIn: SOURCES,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        const resolved = await externalSourceService.resolveUrl(String(input.url || ''));
        jsonResponse(response, 200, { ...resolved, packages: withUnmetRequirements(resolved.packages, await appPackages.hostFacts()) });
      },
    },
    {
      method: 'POST',
      path: '/apps/sources/install',
      signIn: SOURCES,
      bodyLimit: 16 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 201, await externalSourceService.installUrl(String(input.url || ''), {
          config: input.config,
          packageId: typeof input.packageId === 'string' && input.packageId ? input.packageId : null,
        }));
      },
    },
    // The owner asking directly ignores the interval and the failure back-off:
    // the warning on a failing source is what prompts the click.
    {
      method: 'POST',
      pattern: /^\/apps\/sources\/([^/]+)\/refresh$/u,
      signIn: SOURCES,
      handler: async ({ params: [sourceId], response }) => {
        jsonResponse(response, 200, await externalSourceService.refreshSource(sourceId, { force: true }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/apps\/sources\/([^/]+)\/status$/u,
      signIn: SOURCES,
      bodyLimit: 4 * 1024,
      handler: async ({ body, params: [sourceId], response }) => {
        const input = await body();
        jsonResponse(response, 200, {
          source: externalSourceService.setSourceStatus(sourceId, String(input.status || ''), typeof input.reason === 'string' ? input.reason : null),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/apps\/sources\/([^/]+)\/preview$/u,
      signIn: SOURCES,
      bodyLimit: 4 * 1024,
      handler: async ({ body, params: [sourceId], response }) => {
        const input = await body().catch(() => ({}));
        jsonResponse(response, 200, {
          candidate: await externalSourceService.previewCandidate(sourceId, {
            packageId: typeof input?.packageId === 'string' && input.packageId ? input.packageId : null,
          }),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/apps\/sources\/([^/]+)\/remove$/u,
      signIn: SOURCES,
      handler: async ({ params: [sourceId], response }) => {
        jsonResponse(response, 200, await externalSourceService.removeSource(sourceId));
      },
    },
    // Anything else under /apps/sources asks for a session before it is not found.
    {
      pattern: /^\/apps\/sources(?:\/|$)/u,
      signIn: SOURCES,
      handler: async ({ response }) => {
        jsonResponse(response, 404, { error: 'Not found.' });
      },
    },
  ];
}

module.exports = { sourceRoutes };
