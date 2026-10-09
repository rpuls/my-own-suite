import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { openSuiteManager } from '../support/navigation.mjs';
import { installedPackages } from '../support/packages.mjs';
import { capturePageShot } from '../support/screenshots.mjs';
import { followAddress } from './owner.mjs';

const STATUS = '/suite-manager/api/backups/status';

function jobRunning(job) {
  return job && ['queued', 'running'].includes(job.status);
}

function post(page, pathname, body) {
  return apiJson(page, `/suite-manager/api/backups/${pathname}`, { body: JSON.stringify(body), method: 'POST' });
}

// Polls through Suite Manager restarts: a restore replaces the process answering,
// and the sessions it brings back may not include this run's.
async function waitForJobToEnd(ctx, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  let current = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      current = await apiJson(ctx.page, STATUS);
      if (!jobRunning(current.currentJob)) return current;
    } catch (error) {
      lastError = error;
      if (error.status === 401) await followAddress(ctx).catch(() => undefined);
    }
    await ctx.page.waitForTimeout(5000);
  }
  throw new Error(`The backup job did not finish within ${minutes} minutes. Last job: ${JSON.stringify(current?.currentJob || null).slice(0, 300)}${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

async function rememberRecoveryKey(ctx) {
  const { page, env } = ctx;
  const revealed = await post(page, 'recovery-key/reveal', { password: env.owner.password });
  if (!revealed.key) throw new Error('Revealing the recovery key returned no key.');
  ctx.recoveryKey = revealed.key;
  const status = await apiJson(page, STATUS);
  if (!status.recoveryKey?.acknowledged) await apiJson(page, '/suite-manager/api/backups/recovery-key/acknowledge', { method: 'POST' });
}

async function installedIds(page) {
  return (await installedPackages(page)).map((item) => item.id).sort();
}

async function backupToDisk(ctx) {
  const { page } = ctx;
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const status = await apiJson(page, STATUS);
  expect(status.serviceAvailable, 'The backup agent should be available').toBe(true);
  // `ready` is what the screen acts on, so this reports why a destination is
  // unusable instead of failing later as a backup that would not run.
  const usable = (status.destinations || []).filter((item) => item.kind !== 'object' && item.ready);
  const reasons = (status.destinations || []).map((item) => `${item.label || item.id}: ${item.notReadyReason || 'ready'}`).join('; ');
  expect(usable[0], `A ready backup drive is needed (${reasons || 'none reported'})`).toBeTruthy();
  const destination = usable[0];
  await page.getByRole('button', { exact: true, name: `Use ${destination.label} for backups` }).click();

  // MOS refuses to back up until the owner confirms the recovery key is saved;
  // save it the way an owner does rather than reaching past the rule.
  if (!status.recoveryKey?.acknowledged) {
    await page.getByRole('button', { name: /Show key/i }).click();
    const keyDialog = page.getByRole('dialog', { name: /Your recovery key/i });
    await expect(keyDialog.getByRole('checkbox')).toBeVisible({ timeout: 30000 });
    await keyDialog.getByRole('checkbox').check();
    await keyDialog.getByRole('button', { name: /^Done$/u }).click();
    await expect(keyDialog).toBeHidden({ timeout: 30000 });
    expect((await apiJson(page, STATUS)).recoveryKey?.acknowledged, 'Saving the recovery key should unblock backups').toBe(true);
  }

  const apps = await installedIds(page);
  await page.getByRole('button', { name: /Back up now/i }).click();
  await page.getByRole('button', { name: /Start backup/i }).click();
  await expect(page.getByText(/Apps come back on their own/iu)).toBeVisible({ timeout: 30000 });
  const done = await waitForJobToEnd(ctx, 20);
  expect(done.lastJob?.status, `The backup should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  await expect(page.getByText(/Your backups are up to date/iu)).toBeVisible({ timeout: 60000 });
  await capturePageShot(page, 'backups', { fullPage: true });
  const point = (done.backups || []).filter((item) => item.destinationId === destination.id && item.restorable)[0];
  expect(point, 'The new restore point should be listed').toBeTruthy();
  ctx.backups.push({ apps, createdAt: point.createdAt, destination: 'local', destinationId: destination.id, path: point.path, runId: ctx.runId });
}

function bucketSettings(ctx, folder) {
  const bucket = ctx.env.bucket();
  if (!bucket) throw new Error('The lab bucket is not configured: set MOS_LAB_S3_ENDPOINT, _REGION, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY in the environment or through MOS_E2E_SECRETS_COMMAND.');
  return { ...bucket, folder, label: `E2E ${folder}` };
}

async function connectBucket(ctx, folder) {
  const result = await post(ctx.page, 'destinations/object', bucketSettings(ctx, folder));
  const destinationId = result.destination?.id || result.id;
  if (!destinationId) throw new Error(`Connecting the lab bucket returned no destination: ${JSON.stringify(result).slice(0, 200)}`);
  return destinationId;
}

async function waitForDestination(page, destinationId, accept) {
  let last = null;
  await expect(async () => {
    last = ((await apiJson(page, STATUS)).destinations || []).find((item) => item.id === destinationId);
    expect(last && accept(last)).toBeTruthy();
  }).toPass({ intervals: [3000], timeout: 120000 }).catch(() => {
    throw new Error(`The bucket destination did not reach the expected state. Last: ${JSON.stringify(last).slice(0, 300)}`);
  });
  return last;
}

async function backupToBucket(ctx) {
  const { page } = ctx;
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const folder = `e2e-${ctx.runId}`.toLowerCase();
  const destinationId = await connectBucket(ctx, folder);
  await waitForDestination(page, destinationId, (item) => item.ready);
  await rememberRecoveryKey(ctx);

  const apps = await installedIds(page);
  await post(page, 'start', { destinationId, note: `E2E ${ctx.runId}` });
  const done = await waitForJobToEnd(ctx, 25);
  expect(done.lastJob?.status, `The bucket backup should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  const point = (done.backups || []).find((item) => item.destinationId === destinationId && item.restorable);
  expect(point, 'The bucket restore point should be listed').toBeTruthy();
  ctx.backups.push({ apps, createdAt: point.createdAt, destination: 'bucket', destinationId, folder, path: point.path, runId: ctx.runId });
}

export async function backup(ctx, destination) {
  if (destination === 'bucket') await backupToBucket(ctx);
  else await backupToDisk(ctx);
}

// Reconnected from its settings alone, so the restore point is found in the bucket.
// Only a reinstalled lab sees it locked: a reset, and even a key rotation, keep old keys.
async function reconnectBucket(ctx, record) {
  const { page } = ctx;
  const status = await apiJson(page, STATUS);
  for (const item of (status.destinations || []).filter((entry) => entry.kind === 'object')) {
    await post(page, 'destinations/object/remove', { destinationId: item.id });
  }
  const destinationId = await connectBucket(ctx, record.folder);
  const found = await waitForDestination(page, destinationId, (item) => item.locked || item.ready);
  if (found.locked) {
    console.log('[restore:bucket] the bucket is locked to this machine; opening it with the recovery key saved at backup time');
    await post(page, 'destinations/unlock', { destinationId, recoveryKey: ctx.recoveryKey });
    await waitForDestination(page, destinationId, (item) => item.ready);
  }
  const point = ((await apiJson(page, STATUS)).backups || []).find((item) => item.destinationId === destinationId && item.createdAt === record.createdAt);
  expect(point, 'The bucket restore point should be listed after reconnecting').toBeTruthy();
  return { destinationId, path: point.path };
}

export async function restore(ctx, destination) {
  const { page } = ctx;
  const kind = destination || 'local';
  const record = [...ctx.backups].reverse().find((item) => item.destination === kind);
  if (!record) throw new Error(`restore${destination ? `:${destination}` : ''} needs an earlier backup${destination ? `:${destination}` : ''} in this run.`);
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  // Reconnected, the bucket is a destination again, so the record follows it for cleanup.
  if (kind === 'bucket') Object.assign(record, await reconnectBucket(ctx, record));

  // The read-only check first: the same integrity checks the restore preflight
  // runs, proven to pass without touching the running suite.
  await post(page, 'validate', { backupPath: record.path });
  const validated = await waitForJobToEnd(ctx, 15);
  expect(validated.lastJob?.kind, 'The check should be the latest job').toBe('validate');
  expect(validated.lastJob?.status, `The read-only check should pass before restoring (${validated.lastJob?.error || 'no reason reported'})`).toBe('succeeded');

  await post(page, 'restore', { backupPath: record.path, confirmation: 'RESTORE' });
  await page.waitForTimeout(5000);
  const done = await waitForJobToEnd(ctx, 30);
  expect(done.lastJob?.status, `The restore should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  // Finishing is not evidence: the agent must have matched the restored apps and
  // volumes against the restore point, presence and absence.
  expect(done.lastJob?.verification?.apps?.matched, 'The restore must verify the restored apps').toBe(true);
  expect(done.lastJob?.verification?.volumes?.matched, 'The restore must verify the restored volumes').toBe(true);
  expect(done.interruptedRestore, 'No interrupted-restore record should remain').toBeFalsy();

  await followAddress(ctx);
  expect(await installedIds(page), 'The restored apps should be the ones the backup held').toEqual(record.apps);
}

export async function cleanup(ctx) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const status = await apiJson(page, STATUS);
  const failures = [];
  for (const record of ctx.backups) {
    const point = (status.backups || []).find((item) => item.path === record.path || (item.destinationId === record.destinationId && item.createdAt === record.createdAt));
    if (!point) continue;
    try {
      await post(page, 'delete', { backupPath: point.path });
      await waitForJobToEnd(ctx, 10);
    } catch (error) {
      failures.push(`${record.destination} ${record.createdAt}: ${error.message}`);
    }
  }
  const primary = status.primary?.destinationId || status.primaryDestinationId;
  for (const item of (status.destinations || []).filter((entry) => entry.kind === 'object' && entry.id !== primary)) {
    await post(page, 'destinations/object/remove', { destinationId: item.id }).catch((error) => failures.push(`disconnect ${item.label}: ${error.message}`));
  }
  if (failures.length) throw new Error(`Cleanup left things behind:\n${failures.join('\n')}`);
}
