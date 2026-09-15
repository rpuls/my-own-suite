// Suite Manager and the app agent ship in one managed update, so exactly one
// contract version is ever correct on a machine. An agent on another version is
// a managed update that applied half of itself (`AGENTS.md` rule 7), not a tier
// to negotiate: every operation that changes a runtime refuses it and names both
// numbers, and the update preview reports it on the app card.
const APP_AGENT_CONTRACT_VERSION = 10;

// Null for an agent that could not be asked at all: not installed, socket down,
// or an answer MOS has no vocabulary for. That is a permanent state with its own
// message, so it is never folded into the version comparison.
function appAgentContractVersionOf(agentStatus) {
  return Number.isInteger(agentStatus?.contractVersion) ? agentStatus.contractVersion : null;
}

// Null when the agent is exactly this contract, otherwise the reason it cannot
// be used, in the owner's terms. Callers wrap it in their own error type.
function appAgentContractFailure(agentStatus) {
  const reported = appAgentContractVersionOf(agentStatus);
  if (reported === APP_AGENT_CONTRACT_VERSION) return null;
  if (reported === null) {
    return {
      code: 'APP_AGENT_UNAVAILABLE',
      message: 'MOS could not reach the part of itself that runs apps. Restarting the server usually clears this.',
    };
  }
  return {
    code: 'APP_AGENT_CONTRACT_MISMATCH',
    message: `This MOS needs app agent contract ${APP_AGENT_CONTRACT_VERSION} and the installed agent reports ${reported}, so its last update did not fully apply. Update MOS again, then retry.`,
  };
}

module.exports = { APP_AGENT_CONTRACT_VERSION, appAgentContractFailure, appAgentContractVersionOf };
