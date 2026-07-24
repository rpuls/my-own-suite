import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';
import { capturePageShot } from './screenshots.mjs';

function backupRunning(job) {
  return job && ['queued', 'running'].includes(job.status);
}

function latestBackup(status) {
  const backups = [...(status?.backups || [])];
  backups.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return backups[0] || null;
}

export async function createBackupIfAvailable(page, env) {
  if (!env.enableBackup) throw new Error('Hyper-V full E2E requires an early backup after the first app. Set MOS_E2E_ENABLE_BACKUP=1.');
  await openSuiteManager(page, 'Backup');
  const status = await apiJson(page, '/suite-manager/api/backups/status');
  expect(status.serviceAvailable, 'Backup agent should be available for Hyper-V full E2E').toBe(true);
  const destination = (status.destinations || []).find((item) => item.mountState === 'mounted' && item.writable);
  expect(destination, 'Hyper-V full E2E needs a mounted writable backup destination').toBeTruthy();
  await page.getByRole('button', { name: new RegExp(destination.label.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&'), 'iu') }).click().catch(() => undefined);
  await page.getByRole('button', { name: /Back up now/i }).click();
  await expect(page.getByRole('status')).toContainText(/backup|saving|pausing|starting/i, { timeout: 30000 });
  const deadline = Date.now() + 15 * 60 * 1000;
  let current = null;
  while (Date.now() < deadline) {
    current = await apiJson(page, '/suite-manager/api/backups/status');
    if (!backupRunning(current.currentJob)) break;
    await page.waitForTimeout(5000);
  }
  expect(current?.lastJob?.status, 'Backup job should succeed').toBe('succeeded');
  expect((current?.backups || []).length, 'Backup list should include at least one bundle').toBeGreaterThan(0);
  await expect(page.locator('body')).toContainText(/Backup completed|Restore from a backup/i, { timeout: 60000 });
  await capturePageShot(page, 'backups', { fullPage: true });
  return latestBackup(current);
}

export async function restoreBackupIfAvailable(page, env, backup) {
  if (!env.enableRestore) throw new Error('Hyper-V full E2E requires restore validation. Set MOS_E2E_ENABLE_RESTORE=1.');
  if (!backup) throw new Error('Hyper-V full E2E restore validation needs the early backup created after the first app.');

  await openSuiteManager(page, 'Backup');

  // Read-only bundle check first: the same integrity/compatibility checks the
  // restore preflight runs, proven to pass without touching the running suite.
  await apiJson(page, '/suite-manager/api/backups/validate', {
    body: JSON.stringify({ backupPath: backup.path }),
    method: 'POST',
  });
  const validateDeadline = Date.now() + 10 * 60 * 1000;
  let validated = null;
  while (Date.now() < validateDeadline) {
    validated = await apiJson(page, '/suite-manager/api/backups/status');
    if (!backupRunning(validated.currentJob)) break;
    await page.waitForTimeout(5000);
  }
  expect(validated?.lastJob?.kind, 'The bundle check job should be the latest job').toBe('validate');
  expect(validated?.lastJob?.status, 'The read-only bundle check should pass before restoring').toBe('succeeded');

  await apiJson(page, '/suite-manager/api/backups/restore', {
    body: JSON.stringify({ backupPath: backup.path, confirmation: 'RESTORE' }),
    method: 'POST',
  });

  const deadline = Date.now() + 15 * 60 * 1000;
  let current = null;
  while (Date.now() < deadline) {
    try {
      current = await apiJson(page, '/suite-manager/api/backups/status');
      if (!backupRunning(current.currentJob)) break;
    } catch {
      // Suite Manager restarts during restore. Keep polling until it is back.
    }
    await page.waitForTimeout(5000);
  }

  expect(current?.lastJob?.status, 'Restore job should succeed').toBe('succeeded');
  // A restore that merely finishes is not evidence: the agent must have
  // compared the restored app inventory and owned volumes against the bundle
  // and found an exact match, presence and absence.
  expect(current?.lastJob?.verification?.apps?.matched, 'Restore must verify the restored app inventory against the bundle').toBe(true);
  expect(current?.lastJob?.verification?.volumes?.matched, 'Restore must verify restored volumes against the bundle, including absence of later volumes').toBe(true);
  expect(current?.interruptedRestore, 'No interrupted-restore record should remain after a verified restore').toBeFalsy();
  return true;
}
