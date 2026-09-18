'use strict';

// One answer to "does this machine keep its owner's data behind a key".
//
// It is a property of a machine, not a product variant. Two shapes are
// permanent and neither is a legacy of the other: a machine whose disk MOS laid
// out has a vault, and a machine whose disk belongs to someone else — a cloud
// provider's image, a disk with partitions MOS did not create, one too small to
// hold a vault beside the system — does not. A machine installed before vaults
// existed lands in the second group by the same rule, not by a rule of its own.
//
// This file exists because that property was being re-derived in four places at
// once: the reconciler deciding whether to gate dockerd, the backup agent
// deciding what the printed kit says, and two screens deciding what to call the
// recovery key. Four copies of one predicate is how a property becomes a
// product variant, and then a second track nobody meant to build. Every
// consumer asks here, and nothing reads the state string itself.

const fs = require('node:fs');

// Written on the plaintext system partition, because it has to be readable
// before the thing it describes is open.
const VAULT_DESCRIPTOR_PATH = '/etc/mos/vault.json';

const VAULT_STATES = {
  // No descriptor at all: this machine has never been laid out by MOS.
  ABSENT: 'absent',
  // There is a vault and it is closed. Nothing that holds owner data is running.
  LOCKED: 'locked',
  // There is a vault, it is open, and its contents are mounted where the rest
  // of MOS expects them.
  UNLOCKED: 'unlocked',
  // MOS looked at this disk and will not put a vault on it. The reason is
  // recorded, and the owner is told it in those words.
  UNSUPPORTED: 'unsupported',
  // The vault agent could not be reached. Never treated as "no vault": a
  // machine whose agent is down still has whatever it had a minute ago.
  UNKNOWN: 'unknown',
};

// How this machine's security chip is enrolled. It is a setting of the machine,
// not a product variant and not a property of a backup: `automatic` releases
// the key to the machine itself, so a power cut is invisible and a thief who
// switches the machine on gets a running server; `password` makes the chip
// demand the owner's Suite Manager password first, which is what makes a stolen
// machine useless and what costs an absent owner their apps until they type it.
const VAULT_TPM_MODES = { AUTOMATIC: 'automatic', PASSWORD: 'password' };

// Whether the chip's keyslot holds what MOS believes it holds. `needs-repair`
// is what an enrollment that failed leaves behind: the slot is wiped rather
// than left knowing a secret the owner has already replaced, so the machine
// asks for the recovery key until MOS teaches the chip again.
const VAULT_TPM_SLOTS = { ENROLLED: 'enrolled', NEEDS_REPAIR: 'needs-repair' };

/**
 * Whether this machine has a vault, given an agent status or a bare state
 * string. For the descriptor on disk, ask `machineHasVault`.
 *
 * `unknown` is deliberately false-y here and must never be shown to an owner as
 * "not encrypted" — it means MOS could not tell. Callers that put words on a
 * screen check the state for `unknown` themselves; callers that decide whether
 * to do something to the machine want this.
 */
function vaultIsPresent(input) {
  const state = typeof input === 'string' ? input : input?.state;
  return state === VAULT_STATES.LOCKED || state === VAULT_STATES.UNLOCKED;
}

/**
 * Whether this machine waits for the owner's password after a restart, given a
 * descriptor or an agent status.
 *
 * Here for the same reason `vaultIsPresent` is: the answer decides what four
 * separate things do — what the settings switch shows, whether a password
 * change has to be taught to the chip, what the restart dialog warns about,
 * and which claim the encryption statement is allowed to make. A machine whose
 * agent could not be read answers false, which is the safe way round: it
 * understates what is protected rather than promising it.
 */
function vaultAsksForPassword(input) {
  return input?.tpm?.mode === VAULT_TPM_MODES.PASSWORD;
}

// Whether the chip is waiting to be taught this server's password again. True
// only on a machine that has a chip enrollment to repair; a machine with no
// chip is not broken, it simply asks for the recovery key.
function vaultChipNeedsRepair(input) {
  return Boolean(input?.tpm) && input.tpm.slot === VAULT_TPM_SLOTS.NEEDS_REPAIR;
}

// A sync read, because the two callers that need it are a reconciler writing
// systemd units and an agent composing a text file, neither of which gains
// anything from being asynchronous about a 200-byte file.
function readVaultDescriptor(descriptorPath = VAULT_DESCRIPTOR_PATH) {
  try {
    return JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch {
    return null;
  }
}

// A descriptor records decisions, not state: it names the device a vault was
// made on, or the reason none was. Whether that vault is open right now is the
// agent's to answer, never the file's.
function machineHasVault(descriptorPath = VAULT_DESCRIPTOR_PATH) {
  return Boolean(readVaultDescriptor(descriptorPath)?.device);
}

module.exports = {
  VAULT_DESCRIPTOR_PATH,
  VAULT_STATES,
  VAULT_TPM_MODES,
  VAULT_TPM_SLOTS,
  machineHasVault,
  readVaultDescriptor,
  vaultAsksForPassword,
  vaultChipNeedsRepair,
  vaultIsPresent,
};
