const { jsonResponse } = require('../responses.cjs');

const SIGN_IN = 'Sign in to manage your AI.';
const ACTIVITY_SIGN_IN = 'Sign in to see what your AI did.';
const CLIENT = '\\/settings\\/ai\\/clients\\/([^/]+)';

function aiRoutes({ aiConnections }) {
  const answerStatus = async (response) => jsonResponse(response, 200, await aiConnections.status());
  return [
    {
      method: 'GET',
      path: '/settings/ai',
      signIn: SIGN_IN,
      handler: async ({ response }) => answerStatus(response),
    },
    {
      method: 'POST',
      path: '/settings/ai/clients',
      signIn: SIGN_IN,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const { client, token } = aiConnections.createClient(await body());
        jsonResponse(response, 200, { client, status: await aiConnections.status(), token });
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^${CLIENT}$`, 'u'),
      signIn: SIGN_IN,
      bodyLimit: 4 * 1024,
      handler: async ({ body, params: [clientId], response }) => {
        aiConnections.updateClient(clientId, await body());
        await answerStatus(response);
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^${CLIENT}$`, 'u'),
      signIn: SIGN_IN,
      handler: async ({ params: [clientId], response }) => {
        aiConnections.deleteClient(clientId);
        await answerStatus(response);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${CLIENT}\\/token$`, 'u'),
      signIn: SIGN_IN,
      handler: async ({ params: [clientId], response }) => {
        const { token } = aiConnections.rotateClientToken(clientId);
        jsonResponse(response, 200, { status: await aiConnections.status(), token });
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^${CLIENT}\\/levels\\/([^/]+)$`, 'u'),
      signIn: SIGN_IN,
      bodyLimit: 1024,
      handler: async ({ body, params: [clientId, sourceId], response }) => {
        aiConnections.setLevel(clientId, sourceId, (await body())?.level);
        await answerStatus(response);
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^${CLIENT}\\/levels\\/([^/]+)\\/exceptions$`, 'u'),
      signIn: SIGN_IN,
      handler: async ({ params: [clientId, sourceId], response }) => {
        aiConnections.resetExceptions(clientId, sourceId);
        await answerStatus(response);
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^${CLIENT}\\/exceptions\\/([^/]+)$`, 'u'),
      signIn: SIGN_IN,
      bodyLimit: 1024,
      handler: async ({ body, params: [clientId, toolName], response }) => {
        await aiConnections.setException(clientId, toolName, (await body())?.exception ?? null);
        await answerStatus(response);
      },
    },
    {
      method: 'PUT',
      pattern: /^\/settings\/ai\/sources\/([^/]+)\/token$/u,
      signIn: SIGN_IN,
      bodyLimit: 8 * 1024,
      handler: async ({ body, params: [sourceId], response }) => {
        await aiConnections.setSourceToken(sourceId, (await body())?.token);
        await answerStatus(response);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/settings\/ai\/sources\/([^/]+)\/token$/u,
      signIn: SIGN_IN,
      handler: async ({ params: [sourceId], response }) => {
        aiConnections.removeSourceToken(sourceId);
        await answerStatus(response);
      },
    },
    {
      method: 'POST',
      pattern: /^\/settings\/ai\/tools\/([^/]+)\/accept$/u,
      signIn: SIGN_IN,
      handler: async ({ params: [toolName], response }) => {
        await aiConnections.acceptTool(toolName);
        await answerStatus(response);
      },
    },
    {
      method: 'GET',
      path: '/ai/summary',
      signIn: ACTIVITY_SIGN_IN,
      handler: async ({ response }) => jsonResponse(response, 200, aiConnections.summary()),
    },
    {
      method: 'GET',
      path: '/ai/activity',
      signIn: ACTIVITY_SIGN_IN,
      handler: async ({ response, url }) => {
        jsonResponse(response, 200, aiConnections.activity({
          before: url.searchParams.get('before'),
          clientId: url.searchParams.get('client'),
          limit: url.searchParams.get('limit'),
        }));
      },
    },
  ];
}

module.exports = { aiRoutes };
