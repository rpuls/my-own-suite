'use strict';

const { VAULT_HANDOVER, VAULT_STATES, vaultIsPresent } = require('../../../../shared/vault-contract.cjs');

// What this machine still has to hand its owner before Suite Manager opens: the
// server login it generated, and the recovery key while the vault still holds
// the escrowed copy. Read with every setup status, because the page in front of
// Suite Manager is decided from it before the first screen paints.
//
// A read that fails answers `unknown` or `unreadable`, never `done`: a handover
// skipped because an agent was silent or a file could not be opened is a secret
// the owner was never shown.
class HandoverService {
  constructor({ consoleLogin, logger, vaultAgent }) {
    this.consoleLogin = consoleLogin;
    this.logger = logger;
    this.vaultAgent = vaultAgent;
  }

  async state() {
    const login = this.consoleLogin.status();
    return {
      login: login.pending ? 'pending' : (login.unreadable ? 'unreadable' : 'done'),
      recoveryKey: await this.recoveryKey(),
    };
  }

  // The vault agent's own `handover` is the answer: it is `pending` exactly
  // while the escrowed copy exists, which is the window this page exists for.
  // The backup agent's acknowledgement is what ends that window, and a later
  // key rotation takes that acknowledgement back without bringing this page
  // back — a replaced key is Backup & Restore's to hand over.
  async recoveryKey() {
    let vault;
    try {
      vault = await this.vaultAgent.status();
    } catch (error) {
      this.logger.warn('handover-unreadable', { error });
      return 'unknown';
    }
    if (vault.state === VAULT_STATES.UNKNOWN) return 'unknown';
    if (!vaultIsPresent(vault)) return 'done';
    if (vault.handover === VAULT_HANDOVER.PENDING) return 'pending';
    return vault.handover === VAULT_HANDOVER.DONE ? 'done' : 'unknown';
  }
}

module.exports = { HandoverService };
