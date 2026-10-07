'use strict';

const { requestAgent } = require('../agent-request.cjs');

// Status, and the one operation that changes what opens the disk. Unlocking is
// deliberately absent: the page Caddy serves on a locked machine is the only
// place that happens, and by the time Suite Manager is running the vault is open
// by definition.
const VAULT_TIMEOUT_MS = 10_000;
// A rekey is three header writes, but it is called at the end of a restore on a
// machine that has just been working hard.
const REKEY_TIMEOUT_MS = 60_000;
// Teaching the chip is one `systemd-cryptenroll` run, which is quick, but it
// queues behind whatever unlock attempt the agent is already serialising.
const ENROLL_TIMEOUT_MS = 60_000;

class VaultAgentClient {
  constructor({ socketPath = process.env.MOS_VAULT_AGENT_SOCKET || '/run/mos-vault-agent/agent.sock', timeoutMs = VAULT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, { body = null, timeoutMs = this.timeoutMs } = {}) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs }).catch(() => {
      throw Object.assign(new Error('The vault system agent is unavailable.'), {
        code: 'VAULT_AGENT_UNAVAILABLE',
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.message || 'The vault agent rejected the request.'), {
      code: answer.body.code || 'VAULT_AGENT_REJECTED',
    });
  }

  status() { return this.request('GET', '/v1/status'); }

  // Points this machine's vault at a key it was handed. Answers
  // `{ ok: true, vault: false }` on a machine that has no vault, which is not a
  // failure: there is nothing to rekey.
  rekey(nextKey) {
    return this.request('POST', '/v1/vault/rekey', { body: { nextKey }, timeoutMs: REKEY_TIMEOUT_MS });
  }

  // Teaches this machine's chip what it must know. `mode` is `'current'` for a
  // password change or a repair, which must follow the machine's own setting
  // rather than choose one, and an explicit mode only when the owner flipped
  // the switch. The PIN is the owner's password, and the vault agent is not
  // told that: it takes an opaque secret, so a later source for it — a passkey,
  // say — is another caller rather than a redesign.
  enrollChip({ mode = 'current', pin = null } = {}) {
    return this.request('POST', '/v1/vault/tpm', { body: { mode, pin }, timeoutMs: ENROLL_TIMEOUT_MS });
  }
}

module.exports = { REKEY_TIMEOUT_MS, VAULT_TIMEOUT_MS, VaultAgentClient };
