import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';

function backupRunning(job) {
  return job && ['queued', 'running'].includes(job.status);
}

export async function createBackupIfAvailable(page, env) {
  if (!env.enableBackup) return;
  const status = await apiJson(page, '/suite-manager/api/backups/status');
  expect(status.serviceAvailable, 'Backup agent should be available for Hyper-V full E2E').toBe(true);
  const destination = (status.destinations || []).find((item) => item.mountState === 'mounted' && item.writable);
  if (!destination) {
    return;
  }
  await apiJson(page, '/suite-manager/api/backups/start', {
    body: JSON.stringify({ destinationId: destination.id }),
    method: 'POST',
  });
  const deadline = Date.now() + 15 * 60 * 1000;
  let current = null;
  while (Date.now() < deadline) {
    current = await apiJson(page, '/suite-manager/api/backups/status');
    if (!backupRunning(current.currentJob)) break;
    await page.waitForTimeout(5000);
  }
  expect(current?.lastJob?.status, 'Backup job should succeed').toBe('succeeded');
  expect((current?.backups || []).length, 'Backup list should include at least one bundle').toBeGreaterThan(0);
}
