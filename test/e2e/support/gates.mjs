import { expect } from '@playwright/test';

function acceptButton(page) {
  return page.getByRole('button', { name: 'Accept and continue' });
}

function handoverHeading(page) {
  return page.getByRole('heading', { name: /^(Save your (server login|recovery key)|Suite Manager cannot open yet)/u });
}

function saveButton(page) {
  return page.getByRole('button', { name: 'Save and continue' });
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

// The handover page follows the terms on a machine that generated its own
// server login or holds an encrypted disk, and Suite Manager stays shut until
// the owner confirms the secrets are saved. Confirming is recorded on the
// machine, so a lab that already confirmed, or never had either, falls through.
export async function saveHandoverIfPending(page) {
  if (!(await handoverHeading(page).isVisible().catch(() => false))) return false;
  // The secrets are read after the page paints, and the confirmation only
  // appears once they are on screen.
  await expect(saveButton(page)).toBeVisible({ timeout: 30000 });
  await page.getByRole('checkbox', { name: /I have saved/iu }).check();
  await saveButton(page).click();
  await expect(saveButton(page)).toBeHidden({ timeout: 60000 });
  return true;
}

// Waits for sign-in to settle on one of its possible outcomes — the terms gate,
// the handover page, or the Homepage dashboard it hands over to — so callers
// never race the redirect. Returns true when a gate is up.
export async function settleAfterSignIn(page) {
  const atGate = async () => (await acceptButton(page).isVisible().catch(() => false))
    || (await handoverHeading(page).isVisible().catch(() => false));
  await expect(async () => {
    const atHome = new URL(page.url()).pathname === '/';
    expect((await atGate()) || atHome).toBe(true);
  }).toPass({ timeout: 60000 });
  return atGate();
}
