import { jsonResponse } from './api';

export type ConsoleLogin = { password: string; username: string };

// The server login this machine generated for itself: shown once on the
// handover page and deleted when the owner confirms. Whether one is waiting
// arrives with the setup status, so these are the only two calls.
export async function fetchConsoleLogin(): Promise<ConsoleLogin> {
  return jsonResponse<ConsoleLogin>(
    await fetch('/suite-manager/api/settings/console-login/reveal', { method: 'POST' }),
    'Unable to show the server login.',
  );
}

export async function markConsoleLoginSaved(): Promise<void> {
  await jsonResponse(
    await fetch('/suite-manager/api/settings/console-login/acknowledge', { method: 'POST' }),
    'Your confirmation was not recorded.',
  );
}
