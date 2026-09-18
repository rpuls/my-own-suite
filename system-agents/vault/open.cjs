#!/usr/bin/env node
'use strict';

// `mos-vault.service`: the gate every unit holding owner data requires.
//
// It exits 0 when there is a vault and it is open, and 0 as well on a machine
// that has no vault at all — a cloud install, or a disk too small for one —
// because those machines are meant to run. It exits non-zero only when there is
// a vault that did not open, which is what holds dockerd, Suite Manager and
// every agent back while the disk is locked.
//
// Nothing here waits for an owner. A headless machine that blocked boot on a
// passphrase prompt would be a machine with nothing left to ask the owner
// through; the gate fails fast and the agent serves the page instead.

const { STATES, VaultAgentCore } = require('./agent-core.cjs');
const { SystemVaultAdapter } = require('./system-adapter.cjs');

function log(message) {
  process.stdout.write(`[mos-vault] ${message}\n`);
}

async function main() {
  const core = new VaultAgentCore(new SystemVaultAdapter());
  const result = await core.open();

  if (!result.vault) {
    log(`no vault on this machine (${result.reason || 'not applicable'}); starting the suite unencrypted`);
    return 0;
  }
  if (result.created) {
    log('created the encrypted vault and moved app data, agent state and secrets into it');
    return 0;
  }
  if (result.opened) {
    log(`vault open${result.unlockedBy ? ` (${result.unlockedBy})` : ''}`);
    return 0;
  }

  log(`vault is locked: ${result.reason}`);
  log(result.reason === 'needs-password'
    ? 'the suite stays stopped until the owner password is entered on this machine\'s page'
    : 'the suite stays stopped until the recovery key is entered on this machine\'s page');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`failed: ${error?.code || 'VAULT_FAILED'} ${error?.message || 'unknown error'}`);
    for (const detail of error?.details || []) log(detail);
    // A fault is not a locked disk, but it is equally not an open one, and the
    // units behind this gate must not start against a vault that is not there.
    process.exit(1);
  });

module.exports = { STATES };
