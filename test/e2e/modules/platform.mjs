import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { ensureOwnerSession } from '../support/auth.mjs';

const STATUS = '/suite-manager/api/updates/status';
const ACTIVE = new Set(['queued', 'running', 'pending', 'waiting', 'starting']);

async function readStatus(page) {
  return apiJson(page, STATUS).catch(() => null);
}

function brief(status) {
  return `track ${status?.track?.ref || '?'} at ${status?.track?.currentCommit?.slice(0, 7) || '?'}, latest ${status?.latestRevision?.slice(0, 7) || '?'}, updateAvailable ${status?.updateAvailable}`;
}

// The lab follows a branch, so moving that branch is how an update reaches it.
// With `wait`, the step waits for the move: whoever is testing an update pushes
// the new commit to the lab's branch while this runs.
async function waitForUpdate(page, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  let status = null;
  console.log(`[platform-update] waiting up to ${minutes} min for the lab's track to offer an update`);
  while (Date.now() < deadline) {
    status = await readStatus(page);
    if (status?.updateAvailable) return status;
    await page.waitForTimeout(30000);
  }
  throw new Error(`No platform update arrived within ${minutes} minutes (${brief(status)}). Move the lab's branch to the commit under test.`);
}

export async function platformUpdate(ctx, mode) {
  const { page, env } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  let status = mode === 'wait' ? await waitForUpdate(page, 40) : await readStatus(page);
  if (!status) throw new Error('The Updates status could not be read.');
  if (!status.updateAvailable) {
    console.log(`[platform-update] nothing to apply: ${brief(status)}`);
    return;
  }
  const target = status.latestRevision;
  ctx.platformUpdatedFrom = status.track?.currentCommit || null;
  await apiJson(page, '/suite-manager/api/updates/start', { body: '{}', method: 'POST' });

  const deadline = Date.now() + 45 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(15000);
    status = await readStatus(page);
    const job = status?.currentJob;
    const line = `${job?.status || 'restarting'} ${job?.stage || ''}`.trim();
    if (line !== last) console.log(`[platform-update] ${line}`);
    last = line;
    if (status && job && !ACTIVE.has(job.status)) break;
  }
  expect(status?.currentJob?.status, `The platform update should succeed (${status?.currentJob?.error || 'no reason reported'})`).toBe('succeeded');
  await ensureOwnerSession(page, env, ctx.url('/suite-manager/'));
  // The restarted Suite Manager answers before its update agent does.
  let after = null;
  await expect.poll(async () => {
    after = await readStatus(page);
    return after?.track?.currentCommit;
  }, { intervals: [5000], message: `The lab should run the commit it updated to (${brief(after)})`, timeout: 180000 }).toBe(target);
}
