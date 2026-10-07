import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { MOS_UNITS } from '../../../system-agents/diagnostics/agent-core.cjs';
import { loadAppModule } from '../support/catalog.mjs';
import { inspectLogSurface } from '../support/log-surface-rules.mjs';
import { openSuiteManager } from '../support/navigation.mjs';
import { installedPackages } from '../support/packages.mjs';

// The export an owner makes from Settings, read from the downloads folder: only a real
// machine proves the privileged agent answers and the secret walk finds the real layout.
async function exportDiagnosticsBundle(page, entryUrl) {
  await openSuiteManager(page, 'Settings', entryUrl);

  const panel = page.getByRole('heading', { exact: true, level: 3, name: 'Diagnostics file' });
  await expect(panel).toBeVisible();

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: 'Create file' }).click(),
  ]).then(([event]) => event);

  expect(download.suggestedFilename()).toMatch(/^mos-diagnostics-[\d-]+\.txt$/u);
  const savedPath = await download.path();
  const bundle = await fs.readFile(savedPath, 'utf8');

  // The name the screen tells the owner to send must be the name the browser saved.
  const saved = page.locator('.suite-notice-success').filter({ hasText: 'Saved to your downloads' });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(download.suggestedFilename());

  return bundle;
}

async function verifyDiagnosticsBundle(bundle, { holdsSecrets }) {
  expect(bundle.startsWith('MY OWN SUITE — DIAGNOSTICS')).toBeTruthy();
  for (const heading of ['WHAT LOOKS WRONG', 'PLATFORM', 'HOST', 'APPS', 'SERVICES', 'CONTAINERS', 'COLLECTION NOTES']) {
    expect(bundle, `the bundle is missing its ${heading} section`).toContain(heading);
  }

  // Proves a managed update, not only a reinstall, wired the privileged agent onto the machine.
  expect(bundle, 'the diagnostics agent was not reachable from Suite Manager').not.toContain('diagnostics agent unreachable');
  expect(bundle, 'no systemd unit state was collected, so the agent returned nothing useful').toMatch(/mos-suite-manager\.service {2}· {2}active/u);

  // Every unit by name: a collector that loses a random subset of reads passes a check on one.
  for (const unit of MOS_UNITS) {
    const row = new RegExp(`^${unit.replaceAll('.', '\\.')} {2}· {2}(\\S+) {2}· {2}(\\S+)$`, 'mu').exec(bundle);
    expect(row, `the bundle has no state row for ${unit}`).not.toBeNull();
    expect(row.slice(1).join(' '), `the agent could not read the state of ${unit}: ${row[0]}`).not.toMatch(/unknown|unread/u);
  }
  expect(bundle, 'the collection notes name a source that did not answer').toMatch(/Could not collect\s+nothing — every source answered/u);

  expect(bundle, 'no filesystem information was collected').toMatch(/Filesystem\s+Size\s+Used/u);

  expect(bundle, 'no MOS app container was collected').toMatch(/mos-app-[a-z0-9-]+ {2}· {2}/u);

  // Redaction is by exact value, so a walk that found no secrets masks nothing and looks normal.
  // Only an app holding a secret gives the walk something to find; some apps hold none.
  const checked = /Known secrets checked for {3}(\d+)/u.exec(bundle);
  expect(checked, 'the bundle did not report how many secrets it checked for').not.toBeNull();
  if (holdsSecrets) {
    expect(
      Number.parseInt(checked[1], 10),
      'the secret walk found nothing although an installed app holds a secret, so redaction masked nothing',
    ).toBeGreaterThan(0);
  }

  // A healthy twenty-app server measures about 110 KB; this only trips if the budget stopped applying.
  expect(bundle.length, `the bundle grew to ${Math.round(bundle.length / 1024)} KB`).toBeLessThan(400_000);
}

// Every secret this run typed: the owner's, the DNS token, each installed app's
// password setup values, and whatever its own module says it created.
async function runSecrets(ctx, installedIds) {
  const secrets = [['owner password', ctx.env.owner.password], ['Cloudflare API token', ctx.env.cloudflareApiToken]];
  for (const id of installedIds) {
    const state = ctx.state(id);
    for (const fieldId of state.passwordFields || []) secrets.push([`${id} ${fieldId}`, state.setup[fieldId]]);
    const module = await loadAppModule(id);
    for (const { label, value } of module?.secrets?.({ env: ctx.env, setup: state.setup || {}, state }) || []) {
      secrets.push([`${id} ${label}`, value]);
    }
  }
  return secrets;
}

export async function diagnostics(ctx) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const installed = await installedPackages(page);
  const installedIds = installed.map((item) => item.id);
  const holdsSecrets = installed.some(({ instance }) => [...(instance?.config || []), ...(instance?.env || [])].some((row) => row.secret));
  const bundle = await exportDiagnosticsBundle(page, ctx.url('/'));
  await verifyDiagnosticsBundle(bundle, { holdsSecrets });

  const { failures, inventory } = inspectLogSurface(bundle, { secrets: await runSecrets(ctx, installedIds) });
  // Attached whatever the outcome: without the bundle, a failure here throws away
  // the only copy of what the section held. It is redacted and bounded by construction.
  await test.info().attach('diagnostics-bundle.txt', { body: bundle, contentType: 'text/plain' });
  await fs.writeFile(path.join(ctx.resultsDir, 'diagnostics-bundle.txt'), bundle);
  await test.info().attach('log-surface-inventory.txt', { body: inventory, contentType: 'text/plain' });
  const detail = failures.map((failure) => `  - ${failure}`).join('\n');
  expect(failures, `The diagnostics bundle failed log-surface inspection:\n${detail}\n`).toEqual([]);
}
