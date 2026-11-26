const { jsonResponse } = require('../responses.cjs');

const SIGN_IN = 'Sign in to manage AI in your apps.';
const SERVICE = '\\/settings\\/ai-services\\/([^/]+)';
const BODY_LIMIT = 8 * 1024;

function aiServiceRoutes({ aiServices }) {
  return [
    {
      method: 'GET',
      path: '/settings/ai-services',
      signIn: SIGN_IN,
      handler: async ({ response }) => jsonResponse(response, 200, aiServices.status()),
    },
    {
      method: 'POST',
      path: '/settings/ai-services',
      signIn: SIGN_IN,
      bodyLimit: BODY_LIMIT,
      handler: async ({ body, response }) => jsonResponse(response, 200, await aiServices.add(await body())),
    },
    {
      method: 'POST',
      path: '/settings/ai-services/check',
      signIn: SIGN_IN,
      bodyLimit: BODY_LIMIT,
      handler: async ({ body, response }) => jsonResponse(response, 200, await aiServices.check(await body())),
    },
    {
      method: 'POST',
      path: '/settings/ai-services/test',
      signIn: SIGN_IN,
      bodyLimit: BODY_LIMIT,
      handler: async ({ body, response }) => jsonResponse(response, 200, await aiServices.test(await body())),
    },
    {
      method: 'PUT',
      pattern: /^\/settings\/ai-services\/apps\/([^/]+)$/u,
      signIn: SIGN_IN,
      bodyLimit: BODY_LIMIT,
      handler: async ({ body, params: [packageId], response }) => {
        const { serviceId } = await body();
        jsonResponse(response, 200, await aiServices.setAppService(packageId, typeof serviceId === 'string' ? serviceId : null));
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^${SERVICE}$`, 'u'),
      signIn: SIGN_IN,
      bodyLimit: BODY_LIMIT,
      handler: async ({ body, params: [id], response }) => jsonResponse(response, 200, await aiServices.update(id, await body())),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${SERVICE}\\/test$`, 'u'),
      signIn: SIGN_IN,
      handler: async ({ params: [id], response }) => {
        const test = await aiServices.testStored(id);
        jsonResponse(response, 200, { status: aiServices.status(), test });
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^${SERVICE}$`, 'u'),
      signIn: SIGN_IN,
      handler: async ({ params: [id], response }) => jsonResponse(response, 200, await aiServices.remove(id)),
    },
  ];
}

module.exports = { aiServiceRoutes };
