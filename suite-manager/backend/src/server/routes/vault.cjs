const { vaultAsksForPassword, vaultChipNeedsRepair, vaultIsPresent } = require('../../../../../shared/vault-contract.cjs');
const { jsonResponse } = require('../responses.cjs');

const STARTUP_PASSWORD_REFUSALS = {
  INVALID_PASSWORD: [400, 'Your current password is incorrect.'],
  VAULT_AGENT_UNAVAILABLE: [503, 'This server\'s vault agent is not answering, so how it starts was not changed.'],
  VAULT_KEY_UNSAVED: [409, 'Save your recovery key first. It is the only way back in if you forget your password.'],
};

// A refusing chip is reported with the state it left behind: the recovery key
// opens the machine whatever the chip is doing.
function chipRefusal(reason) {
  return reason === 'no-tpm'
    ? 'This machine has no security chip, so it always asks for your recovery key after a restart.'
    : 'This machine\'s security chip would not take the change, so it now opens nothing on its own and this server asks for your recovery key after a restart. Try again, and use your recovery key if it restarts first.';
}

function vaultRoutes({ logger, vault, vaultAgent }) {
  return [
    // An agent that does not answer is `state: 'unknown'`, never "not encrypted".
    // The predicates are answered here so that no screen works them out for itself.
    {
      method: 'GET',
      path: '/settings/vault',
      signIn: 'Sign in to review this server\'s encryption.',
      handler: async ({ response }) => {
        let status = { state: 'unknown' };
        try {
          status = await vaultAgent.status();
        } catch (error) {
          logger.warn('vault-agent-unavailable', { error });
        }
        jsonResponse(response, 200, {
          asksForPassword: vaultAsksForPassword(status),
          chipNeedsRepair: vaultChipNeedsRepair(status),
          encrypted: vaultIsPresent(status),
          vault: status,
        });
      },
    },
    {
      method: 'POST',
      path: '/settings/vault/startup-password',
      signIn: 'Sign in to change how this server starts.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        const result = await vault.setStartupPassword({ password: input.password, wanted: input.enabled === true });
        if (result.refused === 'VAULT_TPM_REFUSED') {
          jsonResponse(response, 409, { code: result.refused, error: chipRefusal(result.reason), reason: result.reason });
          return;
        }
        if (result.refused) {
          const [statusCode, error] = STARTUP_PASSWORD_REFUSALS[result.refused];
          jsonResponse(response, statusCode, { code: result.refused, error });
          return;
        }
        jsonResponse(response, 200, result);
      },
    },
  ];
}

module.exports = { vaultRoutes };
