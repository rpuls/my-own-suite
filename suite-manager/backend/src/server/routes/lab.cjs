const { clearSessionCookie } = require('../cookies.cjs');
const { jsonResponse } = require('../responses.cjs');

const LAB_RESET_DISABLED = { code: 'LAB_RESET_DISABLED', error: 'Lab reset is not enabled on this install.' };

// Unauthenticated on purpose: the e2e suite calls these to return to first-run,
// when no owner exists. Their only containment is disposableLab (docs/decisions.md, 2026-08-08).
function labRoutes({ disposableLab, labResetAgent }) {
  return [
    {
      method: 'POST',
      path: '/lab/reset',
      handler: async ({ response, secure }) => {
        if (!disposableLab) {
          jsonResponse(response, 404, LAB_RESET_DISABLED);
          return;
        }
        const result = await labResetAgent.reset({ reason: 'hyperv-e2e' });
        jsonResponse(response, 202, result, {
          'Set-Cookie': clearSessionCookie(secure),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/lab\/reset\/([^/]+)$/u,
      handler: async ({ params: [resetId], response }) => {
        if (!disposableLab) {
          jsonResponse(response, 404, LAB_RESET_DISABLED);
          return;
        }
        jsonResponse(response, 200, await labResetAgent.resetStatus(resetId));
      },
    },
  ];
}

module.exports = { labRoutes };
