import { jsonResponse } from './api';

export type RevealedRecoveryKey = { key: string; kit: string; kitFilename: string };

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`/suite-manager/api/backups/recovery-key/${path}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

// The two calls both places that show the recovery key make: the handover page
// and Backup & Restore. The backend asks for the owner password on every
// showing after the first; the handover page is the first, and sends none.
export async function fetchRecoveryKey(password = ''): Promise<RevealedRecoveryKey> {
  return jsonResponse<RevealedRecoveryKey>(await post('reveal', { password }), 'Unable to show the recovery key.');
}

export async function markRecoveryKeySaved(): Promise<void> {
  await jsonResponse(await post('acknowledge', {}), 'Unable to record that you saved the recovery key.');
}
