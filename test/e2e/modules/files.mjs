import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { plugDrive, pullDrive } from '../support/drive.mjs';
import { saveHandoverIfPending } from '../support/gates.mjs';
import { runOnLab } from '../support/lab-shell.mjs';
import { appDriveOf, driveReaches } from './drive.mjs';

const { FILES_DIR, STORAGE_MOUNT_ROOT } = createRequire(import.meta.url)('../../../shared/storage-contract.cjs');
const { READ_ONLY_SENTENCE } = createRequire(import.meta.url)('../../../shared/drive-files.cjs');

// Bigger than any one chunk by far, so the upload is many short requests through
// Caddy, each well inside its 60 s cut, and big enough to be cut twice mid-way.
const UPLOAD_BYTES = 2.5 * 1024 * 1024 * 1024;

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function onDrive(driveId, relative) {
  return path.posix.join(STORAGE_MOUNT_ROOT, driveId, FILES_DIR, relative);
}

// Bytes that never repeat, so a chunk landing at the wrong offset changes the hash.
async function makeSourceFile(file, bytes) {
  const hash = crypto.createHash('sha256');
  const cipher = crypto.createCipheriv('aes-128-ctr', crypto.randomBytes(16), crypto.randomBytes(16));
  const block = Buffer.alloc(8 * 1024 * 1024);
  async function* blocks() {
    for (let written = 0; written < bytes; written += block.length) {
      const chunk = cipher.update(block.subarray(0, Math.min(block.length, bytes - written)));
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(blocks(), fs.createWriteStream(file));
  return hash.digest('hex');
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function labSha256(ctx, absolute) {
  return (await runOnLab(ctx.env.labShell, `sha256sum ${quote(absolute)}`)).trim().split(/\s+/u)[0];
}

// The owner's way in: Settings → Storage, the drive's row, Browse files.
async function browseFromSettings(ctx, driveId) {
  const { page } = ctx;
  const settings = ctx.url('/suite-manager/settings#set-storage');
  await page.goto(settings, { waitUntil: 'domcontentloaded' });
  const name = (await apiJson(page, '/suite-manager/api/storage')).storage.find((item) => item.id === driveId)?.name;
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30000 });
  if (await saveHandoverIfPending(page)) await page.goto(settings, { waitUntil: 'domcontentloaded' });
  // Same page, new hash: a dialog a step before left open is still there.
  if (await page.getByRole('dialog').isVisible().catch(() => false)) await page.keyboard.press('Escape');
  const item = page.locator('#set-storage .mos-panel-item').filter({ hasText: name });
  const browse = item.getByRole('button', { exact: true, name: 'Browse files' });
  if (!await browse.isVisible().catch(() => false)) await item.getByRole('button', { name: `Show details for ${name}` }).click();
  return browse;
}

async function openDrive(ctx, driveId) {
  await (await browseFromSettings(ctx, driveId)).click();
  await expect(ctx.page).toHaveURL(new RegExp(`/suite-manager/storage/${driveId}/files`, 'u'));
  await expect(ctx.page.locator('.suite-files-list .mos-panel-list, .suite-files-empty').first()).toBeVisible({ timeout: 30000 });
}

function row(page, name) {
  return page.locator('.suite-files-row').filter({ has: page.locator('.suite-files-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') }) });
}

async function openFolder(page, name) {
  await row(page, name).locator('a.suite-files-name').click();
  await expect(page.locator('.suite-files-crumbs strong')).toHaveText(name, { timeout: 30000 });
}

async function rowAction(page, name, action) {
  const target = row(page, name);
  await target.hover();
  await target.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

// Into the first folder of the first app reading the drive, by what the drive holds.
async function openAppFolder(ctx, apps) {
  const { page } = ctx;
  await openFolder(page, 'apps');
  await openFolder(page, apps[0]);
  const first = page.locator('.suite-files-row a.suite-files-name').first();
  const folder = (await first.textContent()).trim();
  await openFolder(page, folder);
  return ['apps', apps[0], folder].join('/');
}

async function progressOf(page) {
  return Number(await page.locator('.suite-files-upload .mos-progress').first().getAttribute('aria-valuenow').catch(() => 0)) || 0;
}

async function waitForProgress(page, percent, label) {
  await expect.poll(() => progressOf(page), { intervals: [500], message: label, timeout: 10 * 60000 }).toBeGreaterThanOrEqual(percent);
}

// Every chunk the server counted, as [from, to]. Together they must cover the file
// exactly once: a gap is lost bytes, an overlap is bytes appended twice.
function trackChunks(page) {
  const counted = [];
  const listener = async (response) => {
    const url = new URL(response.url());
    if (response.request().method() !== 'PUT' || !/\/files\/uploads\//u.test(url.pathname) || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body) counted.push([Number(url.searchParams.get('offset')), body.offset]);
  };
  page.on('response', listener);
  return { counted, stop: () => page.off('response', listener) };
}

function assertCoveredOnce(counted, size) {
  const sorted = [...counted].sort((left, right) => left[0] - right[0]);
  let at = 0;
  for (const [from, to] of sorted) {
    expect(from, 'every chunk starts where the drive had the file').toBe(at);
    at = to;
  }
  expect(at).toBe(size);
}

// Browse into an app's folder, make a folder, add a multi-GB file through Caddy
// while the connection is cut twice, download it back byte for byte, rename it,
// move it within the drive, and delete the lot with the only-copy acknowledgement.
export async function files(ctx) {
  const { page } = ctx;
  const { apps, driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await openDrive(ctx, driveId);
  const appFolder = await openAppFolder(ctx, apps);

  const folder = `MOS e2e ${ctx.runId}`;
  await page.getByRole('button', { exact: true, name: 'New folder' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(folder);
  await page.getByRole('dialog').getByRole('button', { exact: true, name: 'Create' }).click();
  await expect(row(page, folder)).toBeVisible();
  await openFolder(page, folder);

  const source = path.join(ctx.resultsDir, 'files-upload.bin');
  fs.mkdirSync(ctx.resultsDir, { recursive: true });
  const sourceHash = await makeSourceFile(source, UPLOAD_BYTES);
  const workingFiles = () => runOnLab(ctx.env.labShell, `ls -A ${quote(onDrive(driveId, '.mos-uploads'))} /var/lib/mos/suite-manager/file-uploads 2>/dev/null | grep -v ':$' | grep -v '^$' | sort || true`);
  const before = await workingFiles();
  const chunks = trackChunks(page);
  await page.locator('input[type=file]').setInputFiles(source);

  // Suite Manager going away for a while cuts the upload from the server's end.
  await waitForProgress(page, 20, 'the upload should get under way');
  await runOnLab(ctx.env.labShell, 'systemctl stop mos-suite-manager && sleep 15 && systemctl start mos-suite-manager');
  await expect(page.getByText('Connection lost — retrying')).toBeVisible({ timeout: 10000 });
  await waitForProgress(page, 50, 'the upload should carry on after Suite Manager restarts');
  // And the browser losing its network, from this end.
  await page.context().setOffline(true);
  await expect(page.getByText('Connection lost — retrying')).toBeVisible({ timeout: 90000 });
  await page.waitForTimeout(8000);
  await page.context().setOffline(false);
  await expect(page.locator('.suite-files-upload.is-added')).toBeVisible({ timeout: 20 * 60000 });
  chunks.stop();
  assertCoveredOnce(chunks.counted, UPLOAD_BYTES);

  const name = path.basename(source);
  const landed = onDrive(driveId, `${appFolder}/${folder}/${name}`);
  expect(await labSha256(ctx, landed), 'the file on the drive is the one sent').toBe(sourceHash);
  expect(await workingFiles(), 'nothing half-added is left behind').toBe(before);

  await expect(row(page, name)).toBeVisible();
  const downloading = page.waitForEvent('download', { timeout: 10 * 60000 });
  await rowAction(page, name, 'Download');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(name);
  const saved = path.join(ctx.resultsDir, 'files-download.bin');
  await download.saveAs(saved);
  expect(await sha256Of(saved), 'the download is byte for byte the file sent').toBe(sourceHash);
  fs.rmSync(saved, { force: true });
  fs.rmSync(source, { force: true });

  const renamed = 'Renamed by MOS e2e.bin';
  await rowAction(page, name, 'Rename');
  await page.getByRole('dialog').getByRole('textbox').fill(renamed);
  await page.getByRole('dialog').getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(row(page, renamed)).toBeVisible();

  await rowAction(page, renamed, 'Move');
  const dialog = page.getByRole('dialog');
  await dialog.locator('label').filter({ hasText: new RegExp(`^${appFolder.split('/').slice(1).join(' › ')}$`, 'u') }).click();
  await dialog.getByRole('button', { exact: true, name: 'Move here' }).click();
  await expect(row(page, renamed)).toHaveCount(0);
  await page.locator('.suite-files-crumbs a').last().click();
  await expect(row(page, renamed)).toBeVisible();
  expect(await labSha256(ctx, onDrive(driveId, `${appFolder}/${renamed}`)), 'a move within the drive keeps the file whole').toBe(sourceHash);

  for (const picked of [renamed, folder]) {
    await row(page, picked).hover();
    await row(page, picked).getByRole('checkbox').check();
  }
  await expect(page.getByRole('toolbar', { name: 'Selection' })).toContainText('2 selected');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { exact: true, name: 'Delete' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('button', { exact: true, name: 'Delete' })).toBeDisabled();
  await confirm.getByText('I understand these are the only copies').click();
  await confirm.getByRole('button', { exact: true, name: 'Delete' }).click();
  await expect(row(page, renamed)).toHaveCount(0);
  await expect(row(page, folder)).toHaveCount(0);
  await expect.poll(async () => (await runOnLab(ctx.env.labShell, `ls -A ${quote(onDrive(driveId, '.mos-deleting'))} 2>/dev/null | wc -l`)).trim(), { intervals: [2000], message: 'what was deleted should be erased from the drive', timeout: 120000 }).toBe('0');
}

async function firstFile(page, driveId, folder, depth = 2) {
  const listed = await apiJson(page, `/suite-manager/api/storage/drives/${driveId}/files?path=${encodeURIComponent(folder)}`);
  const file = listed.entries.find((entry) => entry.kind === 'file' && entry.bytes < 100 * 1024 * 1024);
  if (file) return { bytes: file.bytes, path: `${folder}/${file.name}` };
  for (const entry of depth ? listed.entries.filter((item) => item.kind === 'folder') : []) {
    const found = await firstFile(page, driveId, `${folder}/${entry.name}`, depth - 1);
    if (found) return found;
  }
  return null;
}

// A drive that needs a check: browsing and downloading work, every change is refused
// with the sentence the screen shows.
export async function filesReadOnly(ctx) {
  const { page } = ctx;
  const { apps, driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['read-only']);
  await openDrive(ctx, driveId);
  await expect(page.getByText('This drive needs a check, so it opened read-only')).toBeVisible();
  await expect(page.getByRole('button', { exact: true, name: 'New folder' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add files' })).toBeDisabled();
  const appFolder = await openAppFolder(ctx, apps);
  const file = await firstFile(page, driveId, appFolder);
  expect(file, 'the app folder should hold a file to download').toBeTruthy();
  const download = await page.request.get(ctx.url(`/suite-manager/api/storage/drives/${driveId}/files/download?path=${encodeURIComponent(file.path)}`));
  expect(download.status()).toBe(200);
  expect((await download.body()).length).toBe(file.bytes);
  const refused = await page.request.post(ctx.url(`/suite-manager/api/storage/drives/${driveId}/files/folder`), { data: { name: 'not allowed', path: appFolder } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe(READ_ONLY_SENTENCE);
}

// Ejected, the open screen closes by itself; plugged back in, it opens again, with
// no reload in between.
export async function filesLive(ctx) {
  const { page } = ctx;
  const { driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await openDrive(ctx, driveId);
  await expect(page.getByRole('button', { name: 'Add files' })).toBeEnabled();
  await page.evaluate(() => { window.mosFilesNoReload = true; });
  await apiJson(page, `/suite-manager/api/storage/drives/${driveId}/eject`, { method: 'POST' });
  await driveReaches(ctx, driveId, ['ejected'], { minutes: 6 });
  await expect(page.getByText('is not open')).toBeVisible({ timeout: 60000 });
  const settings = await page.context().newPage();
  try {
    const sideCtx = { ...ctx, page: settings };
    await expect(await browseFromSettings(sideCtx, driveId)).toBeDisabled();
  } finally {
    await settings.close();
  }
  await pullDrive(ctx, driveId);
  await plugDrive(ctx, driveId);
  await driveReaches(ctx, driveId, ['ready']);
  await expect(page.getByRole('button', { name: 'Add files' })).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('.suite-files-row').first()).toBeVisible();
  expect(await page.evaluate(() => window.mosFilesNoReload === true), 'the screen came back without a reload').toBe(true);
}

// After an app is uninstalled its folders stay on the drive, listed last and greyed
// in the apps folder, and deleting them gives the space back.
export async function filesLeftovers(ctx) {
  const { page } = ctx;
  const drives = (await apiJson(page, '/suite-manager/api/storage')).storage.filter((item) => item.kind === 'drive' && item.capabilities.writable);
  let found = null;
  for (const drive of drives) {
    const apps = await apiJson(page, `/suite-manager/api/storage/drives/${drive.id}/files?path=apps`).catch(() => null);
    const gone = apps?.entries.find((entry) => entry.appState === 'not-installed');
    if (gone) found = { app: gone.name, apps: apps.entries, bytes: gone.bytes || 0, drive };
  }
  expect(found, 'an uninstalled app should have left its folder on a drive').toBeTruthy();
  const { app, apps, bytes, drive } = found;
  expect(apps.findIndex((entry) => entry.appState) >= apps.findIndex((entry) => !entry.appState), 'folders of apps not reading the drive come last').toBe(true);
  const free = async () => Number((await runOnLab(ctx.env.labShell, `df --output=avail -B1 ${quote(path.posix.join(STORAGE_MOUNT_ROOT, drive.id))} | tail -1`)).trim());
  const before = await free();
  await openDrive(ctx, drive.id);
  await openFolder(page, 'apps');
  await expect(row(page, app)).toHaveClass(/is-unused/u);
  await expect(row(page, app)).toContainText('Not installed');
  await openFolder(page, app);
  const inside = (await apiJson(page, `/suite-manager/api/storage/drives/${drive.id}/files?path=${encodeURIComponent(`apps/${app}`)}`)).entries;
  for (const entry of inside) {
    await row(page, entry.name).hover();
    await page.getByRole('button', { name: `Actions for ${entry.name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByText('I understand this is the only copy').click();
    await confirm.getByRole('button', { exact: true, name: 'Delete' }).click();
    await expect(confirm).toHaveCount(0);
  }
  await expect.poll(async () => (await runOnLab(ctx.env.labShell, `test -e ${quote(onDrive(drive.id, `apps/${app}`))} && echo there || echo gone`)).trim(), { intervals: [2000], message: 'the app folder should be gone from the drive', timeout: 120000 }).toBe('gone');
  await expect.poll(free, { intervals: [2000], message: 'the space should come back', timeout: 120000 }).toBeGreaterThanOrEqual(before + bytes * 0.9);
}
