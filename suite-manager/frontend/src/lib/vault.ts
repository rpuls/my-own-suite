import { jsonResponse } from './api';

// What Suite Manager knows about this machine's vault, as the one route that
// answers it reports it. Four screens read this — the dashboard handover, the
// encryption panel, the key dialog and the restart dialog — and none of them
// re-derives "encrypted" or "asks for a password" from the raw state, for the
// same reason the backend keeps those predicates in one file.
export type VaultView = {
  asksForPassword: boolean;
  chipNeedsRepair: boolean;
  encrypted: boolean;
  recoveryKey: { acknowledged?: boolean; fingerprint?: string } | null;
  vault: {
    sentence?: string | null;
    state: 'absent' | 'locked' | 'unknown' | 'unlocked' | 'unsupported';
    tpm?: { mode: 'automatic' | 'password'; slot: 'enrolled' | 'needs-repair' } | null;
    unlocksItself?: boolean;
  };
};

// How this machine's disk opens after a restart. It is what every sentence
// about the recovery key has to be right about: a machine that opens itself
// never asks for the key, one that asks for a password asks for that, and one
// with no chip asks for the key every time.
export type VaultStartup = 'no-vault' | 'automatic' | 'password' | 'recovery-key';

export async function readVaultView(): Promise<VaultView> {
  return jsonResponse<VaultView>(await fetch('/suite-manager/api/settings/vault'), 'Unable to read this server\'s encryption.');
}

export function startupOf(view: VaultView | null | undefined): VaultStartup {
  if (!view?.encrypted) return 'no-vault';
  if (!view.vault.tpm) return 'recovery-key';
  return view.asksForPassword ? 'password' : 'automatic';
}
