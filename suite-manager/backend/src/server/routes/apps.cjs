const { OfficialCatalogError } = require('../../apps/official-catalog-service.cjs');
const { fileResponse, jsonResponse } = require('../responses.cjs');

const REVIEW = 'Sign in to review app packages.';
const INSTALL = 'Sign in to install app packages.';
const GUIDE_STATUSES = ['viewed', 'completed', 'skipped'];

function packageRoute(action) {
  return new RegExp(`^/apps/packages/([^/]+)/${action}$`, 'u');
}

function catalogRoutes({ appPackages, appUrls, catalogService, externalSourceService, installJobs, updateJobs }) {
  // The UI follows this URL rather than rebuilding it from a manifest host, which
  // for an external app would drop the `ext-` prefix it is really served under.
  const withPublicUrl = (app) => ({ ...app, publicUrl: appUrls.hostFor(app.id) ? appUrls.publicUrlOf(app.id).publicUrl : '' });

  return [
    {
      method: 'GET',
      path: '/apps/packages',
      signIn: REVIEW,
      handler: async ({ response }) => {
        jsonResponse(response, 200, {
          catalog: catalogService.status(),
          packages: appPackages.listPackages(await appPackages.hostFacts()).map((app) => ({ ...withPublicUrl(app), installJob: installJobs.get(app.id), updateJob: updateJobs.get(app.id) })),
        });
        // After the answer, on purpose: the Apps page never waits on a git host,
        // and a source found to have moved shows up on the next load.
        externalSourceService.sweep();
      },
    },
    {
      method: 'POST',
      path: '/apps/catalog/refresh',
      signIn: 'Sign in to refresh the app catalog.',
      handler: async ({ response }) => {
        try {
          const result = await catalogService.refresh();
          jsonResponse(response, 200, result);
        } catch (error) {
          if (!(error instanceof OfficialCatalogError)) throw error;
          jsonResponse(response, 502, {
            code: error.code,
            error: error.message,
            status: error.catalogStatus || catalogService.status(),
          });
        }
      },
    },
    {
      method: 'GET',
      pattern: packageRoute('icon'),
      signIn: REVIEW,
      handler: async ({ params: [packageId], response }) => {
        fileResponse(response, appPackages.iconPath(packageId));
      },
    },
    {
      method: 'GET',
      pattern: packageRoute('screenshots/(\\d{1,3})'),
      signIn: REVIEW,
      handler: async ({ params: [packageId, index], response }) => {
        fileResponse(response, appPackages.screenshotPath(packageId, Number(index)));
      },
    },
  ];
}

function appUpdateRoutes({ appPackages, appUrls, homepageConfig, updateJobs }) {
  return [
    {
      method: 'POST',
      pattern: packageRoute('prepare-update'),
      signIn: 'Sign in to review app updates.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, { comparison: await appPackages.preparePackageUpdate(packageId) });
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('update-job'),
      signIn: 'Sign in to update app packages.',
      bodyLimit: 4 * 1024,
      handler: async ({ body, params: [packageId], response }) => {
        const input = await body();
        jsonResponse(response, 202, { updateJob: updateJobs.begin(packageId, input) });
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('recover-update'),
      signIn: 'Sign in to recover app updates.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.recoverPackageUpdate(packageId, {
          ...appUrls.publicUrlOf(packageId),
          homepageService: homepageConfig,
          publicUrlFor: appUrls.publicUrls(),
        }));
      },
    },
  ];
}

function packageRoutes({ appPackages, appUrls, homepageConfig, installJobs }) {
  const runtimeUrls = (packageId) => ({ ...appUrls.publicUrlOf(packageId), publicUrlFor: appUrls.publicUrls() });

  return [
    {
      method: 'POST',
      pattern: packageRoute('install'),
      signIn: INSTALL,
      bodyLimit: 64 * 1024,
      handler: async ({ body, params: [packageId], response }) => {
        const input = await body();
        jsonResponse(response, 200, { instance: await appPackages.installPackage(packageId, input) });
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('install-job'),
      signIn: INSTALL,
      bodyLimit: 64 * 1024,
      handler: async ({ body, params: [packageId], response }) => {
        const input = await body();
        jsonResponse(response, 202, { installJob: installJobs.begin(packageId, { config: input.config || {}, showOnHomepage: input.showOnHomepage === true }) });
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('add-to-homepage'),
      signIn: 'Sign in to add app packages to Homepage.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.addPackageToHomepage(packageId, homepageConfig, appUrls.publicUrlOf(packageId)));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('apply-runtime'),
      signIn: 'Sign in to apply app runtimes.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.startPackageRuntime(packageId, runtimeUrls(packageId)));
      },
    },
    {
      method: 'POST',
      path: '/apps/integrations/connect',
      signIn: 'Sign in to connect app packages.',
      bodyLimit: 16 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await appPackages.connectPackages({
          consumerPackageId: String(input.consumerPackageId || ''),
          providerCapabilityId: String(input.providerCapabilityId || ''),
          providerPackageId: String(input.providerPackageId || ''),
          requestContext: { publicUrlFor: appUrls.publicUrls() },
          slotId: String(input.slotId || ''),
        }));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('stop'),
      signIn: 'Sign in to stop app packages.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.disablePackage(packageId));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('enable'),
      signIn: 'Sign in to enable app packages.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.enablePackage(packageId, runtimeUrls(packageId)));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('restart'),
      signIn: 'Sign in to restart app packages.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.restartPackageRuntime(packageId, runtimeUrls(packageId)));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('env'),
      signIn: 'Sign in to change app environment variables.',
      bodyLimit: 64 * 1024,
      handler: async ({ body, params: [packageId], response }) => {
        const input = await body();
        jsonResponse(response, 200, await appPackages.savePackageEnvironment(packageId, input, runtimeUrls(packageId)));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('uninstall'),
      signIn: 'Sign in to uninstall app packages.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.uninstallPackage(packageId, homepageConfig));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('refresh-runtime-status'),
      signIn: 'Sign in to refresh app runtime status.',
      handler: async ({ params: [packageId], response }) => {
        jsonResponse(response, 200, await appPackages.refreshPackageRuntimeStatus(packageId));
      },
    },
    {
      method: 'POST',
      pattern: packageRoute('guide'),
      signIn: 'Sign in to update app setup guides.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, params: [packageId], response }) => {
        const input = await body();
        const status = String(input.status || '');
        if (!GUIDE_STATUSES.includes(status)) {
          jsonResponse(response, 400, { code: 'INVALID_GUIDE_STATUS', error: 'Guide status must be viewed, completed, or skipped.' });
          return;
        }
        jsonResponse(response, 200, appPackages.setPackageGuideStatus(packageId, status));
      },
    },
  ];
}

function appRoutes(services) {
  return [...catalogRoutes(services), ...appUpdateRoutes(services), ...packageRoutes(services)];
}

module.exports = { appRoutes };
