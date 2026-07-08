import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';

function backupRunning(job) {
  return job && ['queued', 'running'].includes(job.status);
}

function latestBackup(status) {
  const backups = [...(status?.backups || [])];
  backups.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return backups[0] || null;
}

export async function createBackupIfAvailable(page, env) {
  if (!env.enableBackup) throw new Error('Hyper-V full E2E requires an early backup after the first app. Set MOS_V2_E2E_ENABLE_BACKUP=1.');
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
  return latestBackup(current);
}

export async function restoreBackupIfAvailable(page, env, backup) {
  if (!env.enableRestore) throw new Error('Hyper-V full E2E requires restore validation. Set MOS_V2_E2E_ENABLE_RESTORE=1.');
  if (!backup) throw new Error('Hyper-V full E2E restore validation needs the early backup created after the first app.');

  await openSuiteManager(page, 'Backup');

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
  return true;
}
