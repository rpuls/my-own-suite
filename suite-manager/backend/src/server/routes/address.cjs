const { jsonResponse } = require('../responses.cjs');

const ADDRESS = 'Sign in to manage the suite address.';

function addressRoutes({ addressService }) {
  return [
    {
      method: 'GET',
      path: '/settings/address',
      signIn: ADDRESS,
      handler: async ({ response }) => {
        jsonResponse(response, 200, await addressService.status());
      },
    },
    // 202 before the change runs: for a domain the web server restarts under this
    // very connection, so the screen polls the status instead of waiting.
    {
      method: 'POST',
      path: '/settings/address/change',
      signIn: ADDRESS,
      bodyLimit: 16 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 202, await addressService.change(input));
      },
    },
    {
      method: 'POST',
      path: '/settings/address/change/cancel',
      signIn: ADDRESS,
      handler: async ({ response }) => {
        jsonResponse(response, 202, addressService.cancelChange());
      },
    },
    {
      method: 'POST',
      path: '/settings/address/offer/dismiss',
      signIn: ADDRESS,
      handler: async ({ response }) => {
        jsonResponse(response, 200, await addressService.dismissOffer());
      },
    },
  ];
}

module.exports = { addressRoutes };
