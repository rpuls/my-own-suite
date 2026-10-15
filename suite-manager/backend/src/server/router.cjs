const { readJsonBody } = require('./request.cjs');
const { jsonResponse } = require('./responses.cjs');

// A route is { method, path | pattern, signIn, bodyLimit, handler }, with paths
// relative to the API prefix. The first match in table order wins; an entry
// without a method matches every method.
function matchRoute(routes, method, routePath) {
  for (const route of routes) {
    if (route.method && route.method !== method) continue;
    if (route.path !== undefined) {
      if (route.path === routePath) return { params: [], route };
      continue;
    }
    const captures = route.pattern.exec(routePath);
    if (captures) return { params: captures.slice(1), route };
  }
  return null;
}

// Answers the request and resolves true when a route matched. A route with a
// `signIn` sentence answers 401 with it before its handler runs.
function createRouter(routes, { isSignedIn }) {
  return async (routePath, context) => {
    const matched = matchRoute(routes, context.request.method, routePath);
    if (!matched) return false;
    const { params, route } = matched;
    if (route.signIn && !isSignedIn(context.sessionToken)) {
      jsonResponse(context.response, 401, { code: 'AUTH_REQUIRED', error: route.signIn });
      return true;
    }
    await route.handler({
      ...context,
      body: (limit = route.bodyLimit) => readJsonBody(context.request, limit),
      params: params.map(decodeURIComponent),
    });
    return true;
  };
}

module.exports = { createRouter, matchRoute };
