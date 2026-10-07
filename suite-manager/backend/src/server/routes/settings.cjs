const { jsonResponse } = require('../responses.cjs');

const SECURITY_SUMMARY_DAYS = 30;

function settingsRoutes({ consoleLogin, setup }) {
  return [
    // One keyed route for every preference; setup-service owns the keys and their types.
    {
      method: 'POST',
      path: '/settings/preferences',
      signIn: 'Sign in to change your Suite Manager preferences.',
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, { preferences: setup.setPreference(input) });
      },
    },
    {
      method: 'GET',
      path: '/settings/security-events',
      signIn: 'Sign in to review security activity.',
      handler: async ({ response }) => {
        const since = new Date(Date.now() - SECURITY_SUMMARY_DAYS * 24 * 60 * 60 * 1_000).toISOString();
        jsonResponse(response, 200, { since, ...setup.store.getSecurityEventSummary({ since }) });
      },
    },
    // The console login is shown once and deleted: MOS holds it but does not own it.
    {
      method: 'POST',
      path: '/settings/console-login/reveal',
      signIn: 'Sign in to see the server login.',
      handler: async ({ response }) => {
        // The one response that carries a plaintext credential the owner copies elsewhere.
        jsonResponse(response, 200, consoleLogin.reveal(), { 'Cache-Control': 'no-store' });
      },
    },
    {
      method: 'POST',
      path: '/settings/console-login/acknowledge',
      signIn: 'Sign in to confirm you saved the server login.',
      handler: async ({ response }) => {
        jsonResponse(response, 200, consoleLogin.acknowledge());
      },
    },
  ];
}

module.exports = { settingsRoutes };
