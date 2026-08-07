import { expect } from '@playwright/test';

function acceptButton(page) {
  return page.getByRole('button', { name: 'Accept and continue' });
}

// The terms gate stands between signing in and the rest of MOS, so every flow
// that creates an owner or signs in has to answer it before Suite Manager is
// reachable. Accepting is recorded server-side per terms version, so a lab that
// has already answered falls straight through — which is why this is safe to
// call on a reused environment as well as a fresh install.
export async function acceptTermsIfPending(page) {
  if (!(await acceptButton(page).isVisible().catch(() => false))) return false;
  await page.getByRole('checkbox', { name: /accept the terms of use/iu }).check();
  await acceptButton(page).click();
  // The gate coming down means the acceptance was recorded, so navigating next cannot race it.
  await expect(acceptButton(page)).toBeHidden({ timeout: 60000 });
  return true;
}

// Waits for sign-in to settle on one of its two possible outcomes — the terms
// gate, or the Homepage dashboard it hands over to — so callers never race the
// redirect. Returns true when the gate is up.
export async function settleAfterSignIn(page) {
  await expect(async () => {
    const atGate = await acceptButton(page).isVisible().catch(() => false);
    const atHome = new URL(page.url()).pathname === '/';
    expect(atGate || atHome).toBe(true);
  }).toPass({ timeout: 60000 });
  return acceptButton(page).isVisible().catch(() => false);
}
