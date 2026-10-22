import { createRequire } from 'node:module';

import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { plugDrive, pullDrive } from '../support/drive.mjs';
import { runOnLab } from '../support/lab-shell.mjs';
import { openSuiteManager } from '../support/navigation.mjs';
import { installedPackages } from '../support/packages.mjs';
import { capturePageShot } from '../support/screenshots.mjs';
import { renameInSettings } from './drive.mjs';
import { followAddress } from './owner.mjs';

const { BACKUPS_DIR, STORAGE_MOUNT_ROOT } = createRequire(import.meta.url)('../../../shared/storage-contract.cjs');

const STATUS = '/suite-manager/api/backups/status';
const STORAGE = '/suite-manager/api/storage';

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

// Backups → Add destination, the shared picker, and the storage the owner picks in it.
// A server with no destination yet shows its first-backup choice instead of the list.
async function openDestinationPicker(page) {
  const add = page.getByRole('button', { name: /^Add destination$/u });
  const first = page.getByRole('button', { name: /Use a drive/u });
  await expect(add.or(first)).toBeVisible({ timeout: 60000 });
  await (await add.isVisible() ? add : first).click();
  const dialog = page.getByRole('dialog', { name: 'Add a backup destination' });
  await expect(dialog.getByRole('radiogroup', { name: 'Where backups go' })).toBeVisible({ timeout: 30000 });
  return dialog;
}

async function useForBackups(page, dialog, storageId) {
  await dialog.locator(`input[type=radio][value="${storageId}"]`).check();
  await dialog.getByRole('button', { name: /^Use for backups$/u }).click();
  await expect(dialog).toBeHidden({ timeout: 60000 });
}

async function storageEntries(page) {
  return (await apiJson(page, STORAGE)).storage || [];
}

// The lab's backup drive is whichever drive can hold backups and keeps no app's files.
async function backupDriveDestination(ctx) {
  const { page } = ctx;
  const status = await apiJson(page, STATUS);
  const ready = (status.destinations || []).find((item) => item.kind !== 'object' && item.state === 'ready');
  if (ready) return ready;
  const drive = (await storageEntries(page)).find((item) => item.kind === 'drive' && item.capabilities.holdsBackups && !item.apps.length && ['available', 'ready'].includes(item.state));
  const reasons = (await storageEntries(page)).map((item) => `${item.name}: ${item.state}`).join('; ');
  expect(drive, `A drive that can hold backups is needed (${reasons || 'none listed'})`).toBeTruthy();
  await useForBackups(page, await openDestinationPicker(page), drive.id);
  let found = null;
  await expect.poll(async () => {
    found = ((await apiJson(page, STATUS)).destinations || []).find((item) => item.id === drive.id && item.state === 'ready');
    return Boolean(found);
  }, { message: 'the picked drive should become a ready backup destination', timeout: 60000 }).toBe(true);
  return found;
}

async function backupToDisk(ctx) {
  const { page } = ctx;
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const status = await apiJson(page, STATUS);
  expect(status.serviceAvailable, 'The backup agent should be available').toBe(true);
  const destination = await backupDriveDestination(ctx);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('radio', { exact: true, name: `Use ${destination.label} for backups` }).check();

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
  const point = (done.backups || []).filter((item) => item.placeId === destination.id && item.owner === 'this')[0];
  expect(point, 'The new restore point should be listed').toBeTruthy();
  ctx.backups.push({ apps, createdAt: point.createdAt, destination: 'local', destinationId: destination.id, path: point.path, runId: ctx.runId });
}

function bucketSettings(ctx, folder) {
  const bucket = ctx.env.bucket();
  if (!bucket) throw new Error('The lab bucket is not configured: set MOS_LAB_S3_ENDPOINT, _REGION, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY in the environment or through MOS_E2E_SECRETS_COMMAND.');
  return { ...bucket, folder, label: `E2E ${folder}` };
}

// The bucket form, wherever it was opened from: Settings → Storage, or the backup
// picker's last row, which is how a fresh server reaches the bucket it restores from.
async function fillBucketForm(ctx, chooser, folder) {
  const settings = bucketSettings(ctx, folder);
  await chooser.getByRole('button', { name: /Connect storage online/u }).click();
  const dialog = ctx.page.getByRole('dialog', { name: 'Connect storage online' });
  await dialog.getByLabel(/^Name/u).fill(settings.label);
  await dialog.getByLabel(/^Endpoint/u).fill(settings.endpoint);
  await dialog.getByLabel(/^Bucket/u).fill(settings.bucket);
  await dialog.getByLabel(/^Folder/u).fill(settings.folder);
  await dialog.getByLabel(/^Region/u).fill(settings.region || '');
  await dialog.getByLabel(/^Access key ID/u).fill(settings.accessKeyId);
  await dialog.getByLabel(/^Secret access key/u).fill(settings.secretAccessKey);
  await dialog.getByRole('button', { exact: true, name: 'Connect' }).click();
}

async function bucketId(page, folder) {
  let id = null;
  await expect.poll(async () => {
    id = (await storageEntries(page)).find((item) => item.kind === 'bucket' && item.bucket?.folder === folder)?.id || null;
    return Boolean(id);
  }, { message: 'the connected bucket should be listed in Storage', timeout: 60000 }).toBe(true);
  return id;
}

async function connectBucket(ctx, folder) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/settings#set-storage'), { waitUntil: 'domcontentloaded' });
  await page.locator('#set-storage').getByRole('button', { name: 'Add storage' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add storage' });
  await fillBucketForm(ctx, dialog, folder);
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 120000 });
  const storageId = await bucketId(page, folder);
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  await useForBackups(page, await openDestinationPicker(page), storageId);
  return storageId;
}

async function waitForDestination(page, destinationId, accept) {
  let last = null;
  await expect(async () => {
    last = ((await apiJson(page, STATUS)).destinations || []).find((item) => item.id === destinationId);
    expect(last && accept(last)).toBeTruthy();
  }).toPass({ intervals: [3000], timeout: 120000 }).catch(() => {
    throw new Error(`The destination did not reach the expected state. Last: ${JSON.stringify(last).slice(0, 300)}`);
  });
  return last;
}

function latestBackup(ctx, destination, step) {
  const record = [...ctx.backups].reverse().find((item) => item.destination === destination);
  if (!record) throw new Error(`${step} needs an earlier backup to the backup disk in this run.`);
  return record;
}

async function backupToBucket(ctx) {
  const { page } = ctx;
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const folder = `e2e-${ctx.runId}`.toLowerCase();
  const destinationId = await connectBucket(ctx, folder);
  await waitForDestination(page, destinationId, (item) => item.state === 'ready');
  await rememberRecoveryKey(ctx);

  const apps = await installedIds(page);
  await post(page, 'start', { destinationId, note: `E2E ${ctx.runId}` });
  const done = await waitForJobToEnd(ctx, 25);
  expect(done.lastJob?.status, `The bucket backup should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  const point = (done.backups || []).find((item) => item.placeId === destinationId && item.owner === 'this');
  expect(point, 'The bucket restore point should be listed').toBeTruthy();
  ctx.backups.push({ apps, createdAt: point.createdAt, destination: 'bucket', destinationId, folder, path: point.path, runId: ctx.runId });
}

export async function backup(ctx, destination) {
  if (destination === 'bucket') await backupToBucket(ctx);
  else await backupToDisk(ctx);
}

// The archive in a bucket, once MOS has heard back from it: this server's, or
// another server's locked or opened with its key.
async function waitForArchive(page, placeId, accept) {
  let last = null;
  await expect(async () => {
    last = ((await apiJson(page, STATUS)).archives || []).find((item) => item.placeId === placeId);
    expect(last && accept(last)).toBeTruthy();
  }).toPass({ intervals: [3000], timeout: 120000 }).catch(() => {
    throw new Error(`The bucket's backups did not reach the expected state. Last: ${JSON.stringify(last).slice(0, 300)}`);
  });
  return last;
}

// Reconnected from its settings alone, so the restore point is found in the bucket.
// Only a reinstalled lab sees it locked: a reset, and even a key rotation, keep old keys.
async function reconnectBucket(ctx, record) {
  const { page } = ctx;
  const status = await apiJson(page, STATUS);
  for (const item of (status.destinations || []).filter((entry) => entry.kind === 'object')) {
    await apiJson(page, '/suite-manager/api/storage/buckets/remove', { body: JSON.stringify({ id: item.id }), method: 'POST' });
  }
  // The recovery journey: the bucket is connected from inside the destination picker.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const picker = await openDestinationPicker(page);
  await picker.getByRole('button', { name: /Add storage…/u }).click();
  await fillBucketForm(ctx, page.getByRole('dialog', { name: 'Add storage' }), record.folder);
  const destinationId = await bucketId(page, record.folder);
  await useForBackups(page, page.getByRole('dialog', { name: 'Add a backup destination' }), destinationId);
  const found = await waitForArchive(page, destinationId, () => true);
  if (found.keyState === 'locked') {
    console.log('[restore:bucket] the bucket is locked to this machine; opening it with the recovery key saved at backup time');
    await post(page, 'archives/unlock', { archiveId: found.id, recoveryKey: ctx.recoveryKey });
    await waitForArchive(page, destinationId, (item) => item.keyState === 'borrowed');
  }
  const point = ((await apiJson(page, STATUS)).backups || []).find((item) => item.placeId === destinationId && item.createdAt === record.createdAt);
  expect(point, 'The bucket restore point should be listed after reconnecting').toBeTruthy();
  return { destinationId, path: point.path };
}

// The read-only check first: the same integrity checks the restore preflight
// runs, proven to pass without touching the running suite.
async function checkAndRestore(ctx, backupPath, apps) {
  const { page } = ctx;
  await post(page, 'validate', { backupPath });
  const validated = await waitForJobToEnd(ctx, 15);
  expect(validated.lastJob?.kind, 'The check should be the latest job').toBe('validate');
  expect(validated.lastJob?.status, `The read-only check should pass before restoring (${validated.lastJob?.error || 'no reason reported'})`).toBe('succeeded');

  await post(page, 'restore', { backupPath, confirmation: 'RESTORE' });
  await page.waitForTimeout(5000);
  const done = await waitForJobToEnd(ctx, 30);
  expect(done.lastJob?.status, `The restore should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  // Finishing is not evidence: the agent must have matched the restored apps and
  // volumes against the restore point, presence and absence.
  expect(done.lastJob?.verification?.apps?.matched, 'The restore must verify the restored apps').toBe(true);
  expect(done.lastJob?.verification?.volumes?.matched, 'The restore must verify the restored volumes').toBe(true);
  expect(done.interruptedRestore, 'No interrupted-restore record should remain').toBeFalsy();

  await followAddress(ctx);
  expect(await installedIds(page), 'The restored apps should be the ones the backup held').toEqual(apps);
}

export async function restore(ctx, destination) {
  const kind = destination || 'local';
  const record = [...ctx.backups].reverse().find((item) => item.destination === kind);
  if (!record) throw new Error(`restore${destination ? `:${destination}` : ''} needs an earlier backup${destination ? `:${destination}` : ''} in this run.`);
  await openSuiteManager(ctx.page, 'Backup', ctx.url('/'));
  // Reconnected, the bucket is a destination again, so the record follows it for cleanup.
  if (kind === 'bucket') Object.assign(record, await reconnectBucket(ctx, record));
  await checkAndRestore(ctx, record.path, record.apps);
}

const OTHER_SERVER = 'e2e-old-server';

// Beside the archive a disk backup went to, or in another drive's backups folder,
// a copy as another server would have left it: its restore points name another
// install, and only a fresh key, which that server holds, opens it. Prints the
// copy's folder name and that key.
function otherServerArchive(pointPath, intoDir = null) {
  return `set -euo pipefail
src=$(dirname "$(dirname ${JSON.stringify(pointPath)})")
name=archive-$(head -c4 /dev/urandom | od -An -tx1 | tr -dc 0-9a-f)
into=${intoDir ? JSON.stringify(intoDir) : '$(dirname "$src")'}
mkdir -p "$into"
dst=$into/$name
cp -a "$src" "$dst" 2>/dev/null || { rm -rf "$dst"; cp -r "$src" "$dst"; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export HOME=$work
key=$(node -e 'process.stdout.write(require("/opt/mos/repo/system-agents/backup/recovery-key.cjs").generate().key)')
printf %s "$key" > "$work/key"
restic() { /usr/local/libexec/mos/restic --no-cache --quiet -r "$dst/repository" "$@"; }
RESTIC_PASSWORD_FILE=/var/lib/mos/backup-agent/engine-key restic key add --new-password-file "$work/key"
for id in $(RESTIC_PASSWORD_FILE="$work/key" restic key list --json | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const k of JSON.parse(s))if(!k.current)console.log(k.id)})'); do
  RESTIC_PASSWORD_FILE="$work/key" restic key remove "$id"
done
node - "$dst" ${OTHER_SERVER} <<'JS'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [root, server] = process.argv.slice(2);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
const descriptor = path.join(root, 'MOS-REPOSITORY.json');
write(descriptor, { ...JSON.parse(fs.readFileSync(descriptor, 'utf8')), createdByHostname: server, createdByInstallId: server });
const points = path.join(root, 'restore-points');
for (const name of fs.readdirSync(points).filter((file) => file.endsWith('.json'))) {
  const file = path.join(points, name);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(file, { ...manifest, source: { ...manifest.source, hostname: server, installId: server } });
  fs.writeFileSync(file + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + name + '\\n');
}
JS
printf '{"name":"%s","key":"%s"}' "$name" "$key"`;
}

async function archiveIn(page, archiveId) {
  return ((await apiJson(page, STATUS)).archives || []).find((item) => item.id === archiveId) || null;
}

// A drive holding another server's backups: they are listed apart and locked,
// the drive stays this server's backup place, the other server's key opens them
// without making them changeable, and restoring one makes this server that one,
// with its key and the drive.
export async function takeover(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'takeover');
  const made = JSON.parse(await runOnLab(ctx.env.labShell, otherServerArchive(record.path)));
  const archiveId = `${record.destinationId}/${made.name}`;
  try {
    await openSuiteManager(page, 'Backup', ctx.url('/'));
    let archive = null;
    await expect.poll(async () => { archive = await archiveIn(page, archiveId); return archive?.keyState; }, { message: "the other server's archive should be listed, locked", timeout: 60000 }).toBe('locked');
    expect([archive.owner, archive.writtenBy?.hostname], 'It should be listed as the other server\'s').toEqual(['other', OTHER_SERVER]);
    const destination = ((await apiJson(page, STATUS)).destinations || []).find((item) => item.id === record.destinationId);
    expect(destination?.state, 'The drive should stay ready for this server\'s own backups').toBe('ready');
    await capturePageShot(page, 'backups-other-server', { fullPage: true });

    await post(page, 'archives/unlock', { archiveId, recoveryKey: made.key });
    await expect.poll(async () => (await archiveIn(page, archiveId))?.keyState, { message: 'the other server\'s key should open it', timeout: 60000 }).toBe('borrowed');
    const point = ((await apiJson(page, STATUS)).backups || []).find((item) => item.archiveId === archiveId);
    expect(point?.owner, 'Its restore point should be listed as the other server\'s').toBe('other');
    const refused = await post(page, 'delete', { backupPath: point.path }).then(() => null, (error) => error);
    expect(refused, 'Deleting another server\'s restore point should be refused').toBeTruthy();

    await checkAndRestore(ctx, point.path, record.apps);
    const status = await apiJson(page, STATUS);
    const taken = (status.archives || []).find((item) => item.id === archiveId);
    expect([taken?.owner, taken?.keyState], 'The restore should make the archive this server\'s').toEqual(['this', 'own']);
    expect((status.destinations || []).find((item) => item.id === record.destinationId)?.state, 'The drive should still be this server\'s backup place').toBe('ready');
    await rememberRecoveryKey(ctx);
    expect(ctx.recoveryKey, 'This server should now use the other server\'s recovery key').toBe(made.key);
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf "$(dirname "$(dirname ${JSON.stringify(record.path)})")/../${made.name}"`);
  }
}

// A drive MOS was never told about, holding backups another server left on it,
// is opened on sight when plugged in: Storage says what it holds and Backups
// lists them, with no claim made on the drive.
// A connected drive no app or backup uses, apart from the one given. A lab with no
// drive to spare stops using a second backup drive, as its owner would.
async function spareDrive(ctx, except) {
  const { page } = ctx;
  const free = (entry) => entry.kind === 'drive' && entry.connected && entry.capabilities.holdsBackups && !entry.apps.length && entry.id !== except;
  const extra = (await storageEntries(page)).find((entry) => free(entry) && entry.backups?.destination && !entry.backups.primary);
  if (extra) await post(page, 'destinations/release', { storageId: extra.id });
  const spare = (await storageEntries(page)).find((entry) => free(entry) && !entry.backups?.destination);
  const listed = (await storageEntries(page)).map((item) => `${item.name}: ${item.state}${item.apps.length ? ', apps' : ''}${item.backups?.destination ? ', backups' : ''}`).join('; ');
  expect(spare, `A connected drive no app or backup uses is needed (${listed || 'none listed'})`).toBeTruthy();
  return spare;
}

async function entryOf(page, storageId) {
  return (await storageEntries(page)).find((item) => item.id === storageId) || null;
}

export async function driveFound(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'drive-found');
  const spare = await spareDrive(ctx, record.destinationId);
  const backupsDir = `${STORAGE_MOUNT_ROOT}/${spare.id}/${BACKUPS_DIR}`;
  if (spare.state !== 'ready') await runOnLab(ctx.env.labShell, `systemctl start mos-storage-attach@${spare.id}.service`);
  const made = JSON.parse(await runOnLab(ctx.env.labShell, otherServerArchive(record.path, backupsDir)));
  const archiveId = `${spare.id}/${made.name}`;
  try {
    await pullDrive(ctx, spare.id);
    await plugDrive(ctx, spare.id);
    let seen = null;
    await expect.poll(async () => {
      seen = (await storageEntries(page)).find((item) => item.id === spare.id) || null;
      return seen?.state === 'ready' && !seen.apps.length && !seen.backups?.destination && seen.backups?.otherServers.some((other) => other.id === archiveId);
    }, { intervals: [3000], message: `the drive should open on sight and say it holds another server's backups (last: ${JSON.stringify(seen).slice(0, 200)})`, timeout: 180000 }).toBe(true);
    const archive = await archiveIn(page, archiveId);
    expect([archive?.owner, archive?.keyState], 'Backups should list them as another server\'s, locked').toEqual(['other', 'locked']);
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf ${JSON.stringify(`${backupsDir}/${made.name}`)}`);
  }
}

// Another server's archive erased from Backups: it goes from the list and from the
// drive, while this server's own archive beside it, and the drive's place, stay.
export async function eraseOtherArchive(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'erase-other-archive');
  const made = JSON.parse(await runOnLab(ctx.env.labShell, otherServerArchive(record.path)));
  const archiveId = `${record.destinationId}/${made.name}`;
  const folder = `$(dirname "$(dirname ${JSON.stringify(record.path)})")/../${made.name}`;
  try {
    await openSuiteManager(page, 'Backup', ctx.url('/'));
    let archive = null;
    await expect.poll(async () => { archive = await archiveIn(page, archiveId); return archive?.owner; }, { message: "the other server's archive should be listed", timeout: 60000 }).toBe('other');
    const row = page.locator('.suite-bk-row.is-other-server').filter({ hasText: `From ${OTHER_SERVER}` }).first();
    await row.getByRole('button', { name: `More for ${archive.placeLabel}` }).click();
    await page.getByRole('menuitem', { name: /^Erase these backups/u }).click();
    const dialog = page.getByRole('dialog', { name: /^Erase another server's backups/u });
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { exact: true, name: 'Erase these backups' }).click();
    await expect(dialog).toBeHidden({ timeout: 60000 });
    await expect.poll(() => archiveIn(page, archiveId), { message: 'the erased archive should leave the list', timeout: 60000 }).toBeNull();
    expect((await runOnLab(ctx.env.labShell, `[ -e "${folder}" ] && echo kept || echo gone`)).trim(), 'The archive folder should be gone from the drive').toBe('gone');
    const status = await apiJson(page, STATUS);
    expect((status.destinations || []).find((item) => item.id === record.destinationId)?.state, 'The drive should still be this server\'s backup place').toBe('ready');
    expect((status.backups || []).some((item) => item.placeId === record.destinationId && item.owner === 'this'), 'This server\'s own restore points on the drive should be untouched').toBe(true);
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf "${folder}" "${folder}".erasing-*`);
  }
}

// A backup drive that is not plugged in is forgotten only when the owner asks: it
// leaves Storage and Backups, and plugged back in it is listed again with no claim.
export async function forgetDrive(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'forget-drive');
  const spare = await spareDrive(ctx, record.destinationId);
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  await useForBackups(page, await openDestinationPicker(page), spare.id);
  await waitForDestination(page, spare.id, (item) => item.state === 'ready');
  expect((await apiJson(page, STATUS)).primaryDestination?.destinationId, 'A second destination should not take over automatic backups').not.toBe(spare.id);
  try {
    await pullDrive(ctx, spare.id);
    await expect.poll(async () => (await entryOf(page, spare.id))?.state, { intervals: [3000], message: 'the pulled drive should be listed as not connected', timeout: 120000 }).toBe('away');
    await openSuiteManager(page, 'Backup', ctx.url('/'));
    const row = page.locator('.suite-bk-row:not(.is-other-server)').filter({ hasText: spare.name });
    await row.getByRole('button', { name: `More for ${spare.name}` }).click();
    await page.getByRole('menuitem', { name: 'Forget this drive' }).click();
    await expect.poll(async () => Boolean(await entryOf(page, spare.id)), { intervals: [3000], message: 'the forgotten drive should leave Storage', timeout: 60000 }).toBe(false);
    expect(((await apiJson(page, STATUS)).destinations || []).some((item) => item.id === spare.id), 'The forgotten drive should leave Backups').toBe(false);
  } finally {
    await plugDrive(ctx, spare.id);
  }
  await expect.poll(async () => {
    const back = await entryOf(page, spare.id);
    return back ? `${back.state}${back.backups?.destination ? ', claimed' : ''}` : 'absent';
  }, { intervals: [3000], message: 'plugged back in, the drive should open on sight with no claim', timeout: 180000 }).toBe('ready');
}

// Renamed in Settings → Storage, the backup drive carries its name into Backups and
// a spare drive into the picker; an empty name gives a drive its own label back.
export async function renameStorage(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'rename-storage');
  const spare = await spareDrive(ctx, record.destinationId);
  const backupDrive = await entryOf(page, record.destinationId);
  const names = { backup: 'Backups E2E', spare: 'Spare E2E' };
  const ownName = (entry) => (entry.named ? entry.name : '');
  try {
    await renameInSettings(ctx, record.destinationId, names.backup);
    await renameInSettings(ctx, spare.id, names.spare);
    expect([(await entryOf(page, record.destinationId)).name, (await entryOf(page, spare.id)).name], 'Storage should list the new names').toEqual([names.backup, names.spare]);
    await openSuiteManager(page, 'Backup', ctx.url('/'));
    await expect(page.locator('.suite-bk-row:not(.is-other-server)').filter({ hasText: names.backup })).toBeVisible({ timeout: 30000 });
    expect(((await apiJson(page, STATUS)).destinations || []).find((item) => item.id === record.destinationId)?.label, 'Backups should call the drive by its new name').toBe(names.backup);
    const picker = await openDestinationPicker(page);
    await expect(picker.getByText(names.spare).first()).toBeVisible();
    await picker.getByRole('button', { exact: true, name: 'Cancel' }).click();
    await renameInSettings(ctx, spare.id, '');
    expect((await entryOf(page, spare.id)).name, 'An empty name should give the drive its own label back').toBe(spare.label);
  } finally {
    await renameInSettings(ctx, record.destinationId, ownName(backupDrive)).catch(() => undefined);
    await renameInSettings(ctx, spare.id, ownName(spare)).catch(() => undefined);
  }
}

export async function cleanup(ctx) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const status = await apiJson(page, STATUS);
  const failures = [];
  for (const record of ctx.backups) {
    const point = (status.backups || []).find((item) => item.path === record.path || (item.placeId === record.destinationId && item.createdAt === record.createdAt));
    if (!point) continue;
    try {
      await post(page, 'delete', { backupPath: point.path });
      await waitForJobToEnd(ctx, 10);
    } catch (error) {
      failures.push(`${record.destination} ${record.createdAt}: ${error.message}`);
    }
  }
  const primary = status.primary?.destinationId || status.primaryDestinationId;
  for (const item of (await storageEntries(page)).filter((entry) => entry.kind === 'bucket' && entry.id !== primary)) {
    await apiJson(page, '/suite-manager/api/storage/buckets/remove', { body: JSON.stringify({ id: item.id }), method: 'POST' }).catch((error) => failures.push(`disconnect ${item.label}: ${error.message}`));
  }
  if (failures.length) throw new Error(`Cleanup left things behind:\n${failures.join('\n')}`);
}
