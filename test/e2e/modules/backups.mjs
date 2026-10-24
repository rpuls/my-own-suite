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

// Back up now, as an owner does it: the recovery key saved first if MOS asks for
// it, then the place picked in the dialog. The first backup with no default
// backup destination yet makes its place the default, as the dialog offers.
async function backUpNow(ctx, placeId) {
  const { page } = ctx;
  await page.getByRole('button', { name: /^Back up now$/u }).click();
  const keyDialog = page.getByRole('dialog', { name: /Your recovery key/iu });
  const backupDialog = page.getByRole('dialog', { name: 'Back up now' });
  await expect(keyDialog.or(backupDialog)).toBeVisible({ timeout: 30000 });
  if (await keyDialog.isVisible()) {
    await expect(keyDialog.getByRole('checkbox')).toBeVisible({ timeout: 30000 });
    await keyDialog.getByRole('checkbox').check();
    await keyDialog.getByRole('button', { name: /^Done$/u }).click();
    await expect(keyDialog).toBeHidden({ timeout: 30000 });
    expect((await apiJson(page, STATUS)).recoveryKey?.acknowledged, 'Saving the recovery key should unblock backups').toBe(true);
  }
  await expect(backupDialog.getByRole('radiogroup', { name: 'Where this backup goes' })).toBeVisible({ timeout: 30000 });
  await backupDialog.locator(`input[type=radio][value="${placeId}"]`).check();
  await backupDialog.getByRole('button', { name: /^Start backup$/u }).click();
  await expect(backupDialog).toBeHidden({ timeout: 60000 });
}

async function storageEntries(page) {
  return (await apiJson(page, STORAGE)).storage || [];
}

// The lab's backup drive: the one this server's backups are already on, else
// any ready drive that keeps no app's files.
async function backupDrive(ctx) {
  const { page } = ctx;
  let found = null;
  await expect.poll(async () => {
    const drives = ((await apiJson(page, STATUS)).places || []).filter((item) => item.kind === 'disk' && item.state === 'ready' && !item.holdsAppFiles);
    found = drives.find((item) => item.ownArchive) || drives[0] || null;
    return Boolean(found);
  }, { message: `A ready drive that keeps no app's files is needed (${(await storageEntries(page)).map((item) => `${item.name}: ${item.state}`).join('; ') || 'none listed'})`, timeout: 60000 }).toBe(true);
  return found;
}

async function backupToDisk(ctx) {
  const { page } = ctx;
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const status = await apiJson(page, STATUS);
  expect(status.serviceAvailable, 'The backup agent should be available').toBe(true);
  const destination = await backupDrive(ctx);
  const hadDefault = Boolean(status.primaryDestination);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const apps = await installedIds(page);
  await backUpNow(ctx, destination.id);
  await expect(page.getByText(/Apps come back on their own/iu)).toBeVisible({ timeout: 30000 });
  const done = await waitForJobToEnd(ctx, 20);
  expect(done.lastJob?.status, `The backup should succeed (${done.lastJob?.error || 'no reason reported'})`).toBe('succeeded');
  await expect(page.getByText(/Your backups are up to date/iu)).toBeVisible({ timeout: 60000 });
  await capturePageShot(page, 'backups', { fullPage: true });
  const point = (done.backups || []).filter((item) => item.placeId === destination.id && item.owner === 'this')[0];
  expect(point, 'The new restore point should be listed').toBeTruthy();
  if (!hadDefault) expect(done.primaryDestination?.destinationId, 'The first backup\'s place should become the default backup destination').toBe(destination.id);
  ctx.backups.push({ apps, createdAt: point.createdAt, destination: 'local', destinationId: destination.id, path: point.path, runId: ctx.runId });
}

function bucketSettings(ctx, folder) {
  const bucket = ctx.env.bucket();
  if (!bucket) throw new Error('The lab bucket is not configured: set MOS_LAB_S3_ENDPOINT, _REGION, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY in the environment or through MOS_E2E_SECRETS_COMMAND.');
  return { ...bucket, folder, label: `E2E ${folder}` };
}

// The bucket form in Settings → Storage → Add storage, the one place storage is added.
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
  return bucketId(page, folder);
}

async function waitForPlace(page, placeId, accept) {
  let last = null;
  await expect(async () => {
    last = ((await apiJson(page, STATUS)).places || []).find((item) => item.id === placeId);
    expect(last && accept(last)).toBeTruthy();
  }).toPass({ intervals: [3000], timeout: 120000 }).catch(() => {
    throw new Error(`The place did not reach the expected state. Last: ${JSON.stringify(last).slice(0, 300)}`);
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
  await waitForPlace(page, destinationId, (item) => item.state === 'ready');
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

// An archive in a bucket, once MOS has heard back from it: this server's, or
// another server's locked or opened with its key.
async function waitForArchive(page, placeId, accept) {
  let last = null;
  await expect(async () => {
    last = ((await apiJson(page, STATUS)).archives || []).find((item) => item.placeId === placeId && accept(item));
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
  for (const item of (status.places || []).filter((entry) => entry.kind === 'object')) {
    await apiJson(page, '/suite-manager/api/storage/buckets/remove', { body: JSON.stringify({ id: item.id }), method: 'POST' });
  }
  // The recovery journey: connected in Settings → Storage, the bucket's backups
  // are listed under Backups with nothing else to do.
  const destinationId = await connectBucket(ctx, record.folder);
  await openSuiteManager(page, 'Backup', ctx.url('/'));
  const found = await waitForArchive(page, destinationId, () => true);
  if (found.keyState === 'locked') {
    console.log('[restore:bucket] the bucket is locked to this machine; opening it with the recovery key saved at backup time');
    await post(page, 'archives/unlock', { archiveId: found.id, recoveryKey: ctx.recoveryKey });
    await waitForArchive(page, destinationId, (item) => item.id === found.id && item.keyState === 'borrowed');
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
  // Reconnected, the bucket has a new id, so the record follows it for cleanup.
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
// the drive stays a place this server backs up to, the other server's key opens them
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
    const place = ((await apiJson(page, STATUS)).places || []).find((item) => item.id === record.destinationId);
    expect(place?.state, 'The drive should stay ready for this server\'s own backups').toBe('ready');
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
    expect((status.places || []).find((item) => item.id === record.destinationId)?.state, 'The drive should still take this server\'s backups').toBe('ready');
    await rememberRecoveryKey(ctx);
    expect(ctx.recoveryKey, 'This server should now use the other server\'s recovery key').toBe(made.key);
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf "$(dirname "$(dirname ${JSON.stringify(record.path)})")/../${made.name}"`);
  }
}

// A connected drive no app uses and holding none of this server's backups, apart from the one given.
async function spareDrive(ctx, except) {
  const { page } = ctx;
  const spare = (await storageEntries(page)).find((entry) => entry.kind === 'drive' && entry.connected && entry.capabilities.holdsBackups && !entry.apps.length && !entry.backups?.ours && entry.id !== except);
  const listed = (await storageEntries(page)).map((item) => `${item.name}: ${item.state}${item.apps.length ? ', apps' : ''}${item.backups?.ours ? ', backups' : ''}`).join('; ');
  expect(spare, `A connected drive no app or backup uses is needed (${listed || 'none listed'})`).toBeTruthy();
  return spare;
}

async function entryOf(page, storageId) {
  return (await storageEntries(page)).find((item) => item.id === storageId) || null;
}

// A drive MOS was never told about, holding backups another server left on it,
// is opened on sight when plugged in: Storage says what it holds and Backups
// lists them, with no claim made on the drive.
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
      return seen?.state === 'ready' && !seen.apps.length && !seen.backups?.ours && seen.backups?.otherServers.some((other) => other.id === archiveId);
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
    const row = page.locator('.suite-bk-archives.is-other .mos-panel-item').filter({ hasText: `From ${OTHER_SERVER}` }).first();
    await row.getByRole('button', { name: `More for ${archive.placeLabel}` }).click();
    await page.getByRole('menuitem', { name: /^Erase these backups/u }).click();
    const dialog = page.getByRole('dialog', { name: /^Erase another server's backups/u });
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { exact: true, name: 'Erase these backups' }).click();
    await expect(dialog).toBeHidden({ timeout: 60000 });
    await expect.poll(() => archiveIn(page, archiveId), { message: 'the erased archive should leave the list', timeout: 60000 }).toBeNull();
    expect((await runOnLab(ctx.env.labShell, `[ -e "${folder}" ] && echo kept || echo gone`)).trim(), 'The archive folder should be gone from the drive').toBe('gone');
    const status = await apiJson(page, STATUS);
    expect((status.places || []).find((item) => item.id === record.destinationId)?.state, 'The drive should still take this server\'s backups').toBe('ready');
    expect((status.backups || []).some((item) => item.placeId === record.destinationId && item.owner === 'this'), 'This server\'s own restore points on the drive should be untouched').toBe(true);
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf "${folder}" "${folder}".erasing-*`);
  }
}

// A drive holding this server's backups is a place like any other: pulled, it and
// its backups leave Storage and Backups, and plugged back in they are listed
// again as this server's, with nothing for the owner to do.
export async function driveAway(ctx) {
  const { page } = ctx;
  const record = latestBackup(ctx, 'local', 'drive-away');
  const spare = await spareDrive(ctx, record.destinationId);
  if (spare.state !== 'ready') await runOnLab(ctx.env.labShell, `systemctl start mos-storage-attach@${spare.id}.service`);
  const into = `${STORAGE_MOUNT_ROOT}/${spare.id}/${BACKUPS_DIR}`;
  const name = (await runOnLab(ctx.env.labShell, `set -euo pipefail
src=$(dirname "$(dirname ${JSON.stringify(record.path)})")
name=archive-$(head -c4 /dev/urandom | od -An -tx1 | tr -dc 0-9a-f)
mkdir -p ${JSON.stringify(into)}
cp -r "$src" ${JSON.stringify(into)}/"$name"
printf %s "$name"`)).trim();
  const archiveId = `${spare.id}/${name}`;
  try {
    await expect.poll(async () => (await archiveIn(page, archiveId))?.owner, { intervals: [3000], message: 'the copy should be listed as this server\'s backups', timeout: 120000 }).toBe('this');
    await pullDrive(ctx, spare.id);
    await expect.poll(async () => Boolean(await entryOf(page, spare.id)), { intervals: [3000], message: 'the pulled drive should leave Storage', timeout: 120000 }).toBe(false);
    expect(await archiveIn(page, archiveId), 'Its backups should leave Backups').toBeNull();
    expect(((await apiJson(page, STATUS)).places || []).some((item) => item.id === spare.id), 'The pulled drive should not be offered for a backup').toBe(false);
  } finally {
    await plugDrive(ctx, spare.id);
  }
  try {
    await expect.poll(async () => (await archiveIn(page, archiveId))?.owner, { intervals: [3000], message: 'plugged back in, its backups should be listed as this server\'s again', timeout: 180000 }).toBe('this');
  } finally {
    await runOnLab(ctx.env.labShell, `rm -rf ${JSON.stringify(`${into}/${name}`)}`);
  }
}

// Renamed in Settings → Storage, the backup drive carries its name into Backups and
// a spare drive into the Back up now picker; an empty name gives a drive its own label back.
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
    await expect(page.locator('.suite-bk-archives.is-this .mos-panel-item').filter({ hasText: names.backup })).toBeVisible({ timeout: 30000 });
    expect(((await apiJson(page, STATUS)).places || []).find((item) => item.id === record.destinationId)?.label, 'Backups should call the drive by its new name').toBe(names.backup);
    await page.getByRole('button', { name: /^Back up now$/u }).click();
    const picker = page.getByRole('dialog', { name: 'Back up now' });
    await expect(picker.getByText(names.spare).first()).toBeVisible({ timeout: 30000 });
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
  const primary = status.primaryDestination?.destinationId;
  for (const item of (await storageEntries(page)).filter((entry) => entry.kind === 'bucket' && entry.id !== primary)) {
    await apiJson(page, '/suite-manager/api/storage/buckets/remove', { body: JSON.stringify({ id: item.id }), method: 'POST' }).catch((error) => failures.push(`disconnect ${item.label}: ${error.message}`));
  }
  if (failures.length) throw new Error(`Cleanup left things behind:\n${failures.join('\n')}`);
}
