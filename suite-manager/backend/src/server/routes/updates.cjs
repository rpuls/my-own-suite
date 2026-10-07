const { jsonResponse } = require('../responses.cjs');

const MANAGE = 'Sign in to manage updates.';

function updateRoutes({ setup, updates }) {
  return [
    {
      method: 'GET',
      path: '/updates/status',
      signIn: 'Sign in to review updates.',
      handler: async ({ response }) => {
        jsonResponse(response, 200, await updates.status());
      },
    },
    {
      method: 'POST',
      path: '/updates/start',
      signIn: 'Sign in to update My Own Suite.',
      handler: async ({ response, sessionToken }) => {
        jsonResponse(response, 202, await updates.start({ initiator: setup.status(sessionToken).owner?.email || 'owner' }));
      },
    },
    // The two answers an owner can give while an update waits for its backup.
    {
      method: 'POST',
      path: '/updates/cancel',
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await updates.cancel({ id: input?.id }));
      },
    },
    {
      method: 'POST',
      path: '/updates/skip-backup',
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await updates.skipBackup({ id: input?.id }));
      },
    },
    // MOS said a restart was needed, so MOS performs it; the agent refuses it
    // under a running update or backup.
    {
      method: 'POST',
      path: '/updates/host/restart',
      signIn: 'Sign in to restart this server.',
      handler: async ({ response }) => {
        jsonResponse(response, 202, await updates.restartHost());
      },
    },
    {
      method: 'POST',
      path: '/updates/track',
      signIn: 'Sign in to switch update tracks.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        if (input.track !== 'stable' && input.track !== 'main' && input.track !== 'staging') {
          jsonResponse(response, 400, { code: 'INVALID_UPDATE_TRACK', error: 'Update track must be stable, main, or staging.' });
          return;
        }
        jsonResponse(response, 200, await updates.configureTrack(input));
      },
    },
  ];
}

module.exports = { updateRoutes };
