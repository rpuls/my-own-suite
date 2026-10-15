const { VAULT_TPM_MODES, vaultChipNeedsRepair } = require('../../../../shared/vault-contract.cjs');

// The chip's side of the owner password. MOS holds that password in plaintext
// only for a password change, a sign-in and the startup-password switch, and
// these are the only paths that send it to the vault agent.
class VaultService {
  constructor({ agent, logger, verifyOwnerPassword }) {
    this.agent = agent;
    this.logger = logger;
    this.verifyOwnerPassword = verifyOwnerPassword;
  }

  // Never refuses the password change: a chip that will not take the new
  // password ends up holding nothing, and the result says so.
  async teachOwnerPassword(password) {
    try {
      const enrolled = await this.agent.enrollChip({ mode: 'current', pin: password });
      // Nothing to report on a machine with no vault, no chip, or one that opens itself.
      if (enrolled.ok) return enrolled.unchanged || enrolled.vault === false ? null : { mode: enrolled.mode, ok: true };
      return { mode: enrolled.mode || null, ok: false, reason: enrolled.reason || 'tpm-refused' };
    } catch (error) {
      this.logger.warn('vault-chip-enroll-failed', { error });
      return { mode: null, ok: false, reason: 'vault-agent-unavailable' };
    }
  }

  // Finishes a chip enrollment that failed earlier, in either mode. The sign-in
  // does not wait for it; the next sign-in tries again.
  async repairOnSignIn(password) {
    try {
      const vault = await this.agent.status();
      if (!vaultChipNeedsRepair(vault)) return;
      const enrolled = await this.agent.enrollChip({ mode: 'current', pin: password });
      this.logger.info('vault-chip-repair', { ok: Boolean(enrolled.ok), reason: enrolled.reason || null });
    } catch (error) {
      this.logger.warn('vault-chip-repair-failed', { error });
    }
  }

  // Whether the chip asks for the owner's password before it opens the disk. The
  // current password confirms the switch and is what gets enrolled. Answers
  // `{ refused: code }` or the new state.
  async setStartupPassword({ password, wanted }) {
    if (!await this.verifyOwnerPassword(password)) return { refused: 'INVALID_PASSWORD' };
    let enrolled;
    try {
      // A password the owner may forget must not become the only way in before
      // they hold the recovery key, which is the other way in.
      if (wanted && (await this.agent.status()).handover === 'pending') return { refused: 'VAULT_KEY_UNSAVED' };
      enrolled = await this.agent.enrollChip({
        mode: wanted ? VAULT_TPM_MODES.PASSWORD : VAULT_TPM_MODES.AUTOMATIC,
        pin: wanted ? String(password) : null,
      });
    } catch (error) {
      this.logger.warn('vault-agent-unavailable', { error });
      return { refused: 'VAULT_AGENT_UNAVAILABLE' };
    }
    if (!enrolled.ok) return { reason: enrolled.reason || null, refused: 'VAULT_TPM_REFUSED' };
    return {
      asksForPassword: enrolled.mode === VAULT_TPM_MODES.PASSWORD,
      vault: await this.agent.status().catch(() => ({ state: 'unknown' })),
    };
  }
}

module.exports = { VaultService };
