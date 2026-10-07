const { jsonResponse } = require('../responses.cjs');

const RELAY = 'Sign in to manage the email relay.';

function smtpRoutes({ smtpSettings }) {
  return [
    {
      method: 'DELETE',
      path: '/settings/smtp',
      signIn: RELAY,
      handler: async ({ response }) => {
        jsonResponse(response, 200, smtpSettings.remove());
      },
    },
    {
      method: 'GET',
      path: '/settings/smtp',
      signIn: RELAY,
      handler: async ({ response }) => {
        jsonResponse(response, 200, smtpSettings.status());
      },
    },
    {
      method: 'POST',
      path: '/settings/smtp',
      signIn: RELAY,
      bodyLimit: 16 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await smtpSettings.save(input));
      },
    },
    {
      method: 'POST',
      path: '/settings/smtp/test',
      signIn: RELAY,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await smtpSettings.sendTest({ to: input?.to }));
      },
    },
  ];
}

module.exports = { smtpRoutes };
