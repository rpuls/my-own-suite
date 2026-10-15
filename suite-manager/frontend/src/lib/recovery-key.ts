import { postJson } from './api';

export type RevealedRecoveryKey = { key: string; kit: string; kitFilename: string };

const KEY_API = '/suite-manager/api/backups/recovery-key';

// The two calls both places that show the recovery key make: the handover page
// and Backup & Restore. The backend asks for the owner password on every
// showing after the first; the handover page is the first, and sends none.
export async function fetchRecoveryKey(password = ''): Promise<RevealedRecoveryKey> {
  return postJson<RevealedRecoveryKey>(`${KEY_API}/reveal`, { password }, 'Unable to show the recovery key.');
}

export async function markRecoveryKeySaved(): Promise<void> {
  await postJson(`${KEY_API}/acknowledge`, {}, 'Unable to record that you saved the recovery key.');
}
