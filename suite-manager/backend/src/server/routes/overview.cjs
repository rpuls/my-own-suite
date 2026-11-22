const { jsonResponse } = require('../responses.cjs');

function overviewRoutes({ attention }) {
  return [
    {
      method: 'GET',
      path: '/overview',
      signIn: 'Sign in to see how your suite is doing.',
      handler: async ({ response }) => jsonResponse(response, 200, await attention.overview()),
    },
  ];
}

module.exports = { overviewRoutes };
