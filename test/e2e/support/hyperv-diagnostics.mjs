import fs from 'node:fs/promises';

import { expect } from '@playwright/test';

import { openSuiteManager } from './hyperv-navigation.mjs';

// Exercises the owner-facing diagnostics export the way an owner does: open
// Settings, press the button, read what lands in the downloads folder.
//
// Everything asserted here is something only a real installed machine can prove.
// The unit tests cover the rendering and the redaction against fixtures and a
// temp directory; what they cannot cover is whether the privileged agent is
// actually installed and reachable on a machine that already existed, and
// whether the secret walk finds the real directory layout. Both have failed
// silently before — a bundle with no secret set masks nothing and still looks
// perfectly normal.
export async function exportDiagnosticsBundle(page, entryUrl = '/') {
  await openSuiteManager(page, 'Settings', entryUrl);

  const panel = page.getByRole('heading', { exact: true, level: 2, name: 'When something is not working' });
  await expect(panel).toBeVisible();

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: 'Create diagnostics file' }).click(),
  ]).then(([event]) => event);

  expect(download.suggestedFilename()).toMatch(/^mos-diagnostics-[\d-]+\.txt$/u);
  const savedPath = await download.path();
  const bundle = await fs.readFile(savedPath, 'utf8');

  // Notice renders its title as <strong>, not a heading, so this is located by
  // its success variant and text. Asserting the filename too checks the thing
  // that actually matters to an owner: the name the screen tells them to send is
  // the name the browser saved.
  const saved = page.locator('.suite-notice-success').filter({ hasText: 'Saved to your downloads' });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(download.suggestedFilename());

  return bundle;
}

export async function verifyDiagnosticsBundle(bundle) {
  expect(bundle.startsWith('MY OWN SUITE — DIAGNOSTICS')).toBeTruthy();
  for (const heading of ['WHAT LOOKS WRONG', 'PLATFORM', 'HOST', 'APPS', 'SERVICES', 'CONTAINERS', 'COLLECTION NOTES']) {
    expect(bundle, `the bundle is missing its ${heading} section`).toContain(heading);
  }

  // The privileged agent is installed, running, and reachable over its socket.
  // This is the assertion that a managed update — not a reinstall — wired the
  // new unit onto a machine that already existed, which is the failure this
  // whole class of change keeps producing.
  expect(bundle, 'the diagnostics agent was not reachable from Suite Manager').not.toContain('diagnostics agent unreachable');
  expect(bundle, 'no systemd unit state was collected, so the agent returned nothing useful').toMatch(/mos-suite-manager\.service {2}· {2}active/u);

  // Real host facts rather than an empty section: df output names a mount.
  expect(bundle, 'no filesystem information was collected').toMatch(/Filesystem\s+Size\s+Used/u);

  // Docker collection reached the app containers this suite just installed.
  expect(bundle, 'no MOS app container was collected').toMatch(/mos-app-[a-z0-9-]+ {2}· {2}/u);

  // The one that matters most. Suite Manager redacts by exact value, so a run
  // that found no secrets masks nothing while looking entirely normal — and the
  // file would be shipped to a stranger with app tokens in it. The count is in
  // the file precisely so this can be asserted from outside.
  const checked = /Known secrets checked for {3}(\d+)/u.exec(bundle);
  expect(checked, 'the bundle did not report how many secrets it checked for').not.toBeNull();
  expect(
    Number.parseInt(checked[1], 10),
    'the secret walk found nothing on a machine with apps installed, so redaction masked nothing',
  ).toBeGreaterThan(0);

  // Bounded on purpose: the file is meant to be read in full, by a person or a
  // model. This is a generous ceiling — a healthy twenty-app server measures
  // around 110 KB — that only trips if the budget stopped being applied.
  expect(bundle.length, `the bundle grew to ${Math.round(bundle.length / 1024)} KB`).toBeLessThan(400_000);
}
