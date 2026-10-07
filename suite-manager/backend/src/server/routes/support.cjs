const { assembleSupportBundle } = require('../../diagnostics/support-bundle.cjs');

// Signed in only: the file reports the shape of the machine, and an export
// anyone could fetch would be a reconnaissance endpoint.
function supportRoutes({ appAgent, appPackages, catalogService, diagnosticsAgent, frontDoor, homeHost, setup, suiteAddress, updates }) {
  return [
    {
      method: 'GET',
      path: '/support/bundle',
      signIn: 'Sign in to create a diagnostics file.',
      handler: async ({ response }) => {
        const bundle = await assembleSupportBundle({
          agent: diagnosticsAgent,
          appAgent,
          catalogStatus: catalogService.status(),
          frontDoor,
          homeHost: suiteAddress.readOrNull()?.host || homeHost,
          platformVersion: catalogService.platformVersion,
          secretDir: appPackages.secretDir,
          store: setup.store,
          suiteAddress: suiteAddress.readOrNull(),
          updateStatus: await updates.status().catch(() => null),
        });
        response.writeHead(200, {
          'Content-Disposition': `attachment; filename="${bundle.filename}"`,
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end(bundle.text);
      },
    },
  ];
}

module.exports = { supportRoutes };
