const { jsonResponse } = require('../responses.cjs');

const CUSTOMIZE = 'Sign in to customize Homepage.';

function customizeRoutes({ homepageConfig }) {
  const post = (path, operation) => ({
    method: 'POST',
    path,
    signIn: CUSTOMIZE,
    bodyLimit: 600 * 1024,
    handler: async ({ body, response }) => {
      const input = await body();
      jsonResponse(response, 200, await operation(input));
    },
  });
  return [
    {
      method: 'GET',
      path: '/customize/status',
      signIn: CUSTOMIZE,
      handler: async ({ response }) => {
        jsonResponse(response, 200, await homepageConfig.status());
      },
    },
    post('/customize/file/read', (input) => homepageConfig.read(input)),
    post('/customize/file/validate', (input) => homepageConfig.validate(input)),
    post('/customize/file/apply', (input) => homepageConfig.apply(input)),
    post('/customize/add-link', (input) => homepageConfig.add(input, false)),
    post('/customize/add-home-service', (input) => homepageConfig.add(input, true)),
    post('/customize/home-service-preview', (input) => homepageConfig.previewHomeService(input)),
    // Anything else under /customize/ asks for a session before it is not found.
    {
      pattern: /^\/customize\//u,
      signIn: CUSTOMIZE,
      handler: async ({ response }) => {
        jsonResponse(response, 404, { error: 'Not found.' });
      },
    },
  ];
}

module.exports = { customizeRoutes };
