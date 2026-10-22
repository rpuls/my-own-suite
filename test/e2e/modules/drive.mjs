import { createRequire } from 'node:module';

import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { mountOptions, plugDrive, pullDrive, REMEMBER_LOOPS, RESTORE_LOOPS, writeInFlight } from '../support/drive.mjs';
import { saveHandoverIfPending } from '../support/gates.mjs';
import { vmAddress } from '../support/hyperv.mjs';
import { runOnLab } from '../support/lab-shell.mjs';
import { appRunning, installedPackages, waitForRunning } from '../support/packages.mjs';
import { followAddress } from './owner.mjs';

const { easyDoorHomeHost, parseEasyDoorHost } = createRequire(import.meta.url)('../../../shared/easy-door.cjs');

// A disk image on a loop device, which MOS treats like any drive plugged in. Kept
// between runs, so a later run finds the files an earlier one left on it.
const ATTACH_IMAGE = {
  ntfs: `set -e
image=/var/lib/mos-lab-drive-ntfs.img
losetup -j "$image" | grep -q . && exit 0
[ -f "$image" ] || { truncate -s 2G "$image"; mkfs.ntfs --quick --label LABNTFS "$image" >/dev/null; }
losetup --find --show "$image"`,
  vfat: `set -e
image=/var/lib/mos-lab-drive.img
losetup -j "$image" | grep -q . && exit 0
[ -f "$image" ] || { truncate -s 2G "$image"; mkfs.vfat -F 32 -n LABDRIVE "$image" >/dev/null; }
losetup --find --show "$image"`,
};

const STORAGE = '/suite-manager/api/storage';

async function listDrives(page) {
  return ((await apiJson(page, STORAGE).catch(() => ({ storage: [] }))).storage || []).filter((item) => item.kind === 'drive');
}

function holdsAppFiles(item) {
  return item.capabilities.holdsAppFolders && ['available', 'ready'].includes(item.state);
}

export async function drive(ctx, fileSystem) {
  const wanted = fileSystem || null;
  const offered = async () => (await listDrives(ctx.page)).filter((item) => holdsAppFiles(item) && (!wanted || item.fileSystem === wanted));
  if (!(await offered()).length) {
    await runOnLab(ctx.env.labShell, ATTACH_IMAGE[wanted || 'vfat']);
    await expect.poll(async () => (await offered()).length, { message: `the lab's ${wanted || ''} drive should be offered for app files`, timeout: 60000 }).toBeGreaterThan(0);
  }
  if (wanted) ctx.labDrive = (await offered())[0].id;
}

export async function appDriveOf(ctx) {
  const installed = await installedPackages(ctx.page);
  const holder = installed.find((app) => app.instance?.folders?.length);
  if (!holder) throw new Error('No installed app keeps files on a drive; install one first.');
  const driveId = holder.instance.folders[0].driveId;
  const apps = installed.filter((app) => app.instance?.folders?.some((folder) => folder.driveId === driveId)).map((app) => app.id);
  const found = (await listDrives(ctx.page)).find((item) => item.id === driveId);
  return { apps, driveId, fileSystem: found?.fileSystem || null };
}

export async function driveReaches(ctx, driveId, states, { minutes = 2 } = {}) {
  let last = null;
  await expect.poll(async () => {
    last = (await listDrives(ctx.page)).find((item) => item.id === driveId) || null;
    return states.includes(last?.state);
  }, { intervals: [3000], message: `the drive should be ${states.join(' or ')}`, timeout: minutes * 60000 }).toBe(true);
  return last;
}

async function appsRunAgain(ctx, apps) {
  for (const id of apps) expect(appRunning(await waitForRunning(ctx.page, id, { minutes: 5 })), `${id} should run on its drive again`).toBe(true);
}

// An NTFS drive Windows would check first opens read-only, so its apps keep their
// files; exFAT and FAT32 are opened as they are.
function afterUncleanStates(fileSystem) {
  return fileSystem === 'ntfs' ? ['read-only'] : ['ready'];
}

export async function drivePull(ctx) {
  const { apps, driveId, fileSystem } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await pullDrive(ctx, driveId);
  await plugDrive(ctx, driveId);
  const back = await driveReaches(ctx, driveId, afterUncleanStates(fileSystem));
  if (back.state === 'read-only') expect(await mountOptions(ctx, driveId)).toContain('ro');
  await appsRunAgain(ctx, apps);
}

// The row for one drive or bucket in Settings → Storage, as the owner reaches it.
export async function storageRow(ctx, storageId) {
  const { page } = ctx;
  const name = ((await apiJson(page, STORAGE).catch(() => ({ storage: [] }))).storage || []).find((item) => item.id === storageId)?.name;
  const settings = ctx.url('/suite-manager/settings#set-storage');
  await page.goto(settings, { waitUntil: 'domcontentloaded' });
  // A restart can put the lab's handover gate back in front of Suite Manager.
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30000 });
  if (await saveHandoverIfPending(page)) await page.goto(settings, { waitUntil: 'domcontentloaded' });
  const item = page.locator('#set-storage .mos-panel-item').filter({ hasText: name });
  await expect(item).toBeVisible({ timeout: 30000 });
  return { item, name };
}

async function expandRow({ item, name }) {
  const details = item.getByRole('button', { name: `Show details for ${name}` });
  if (await details.isVisible().catch(() => false)) await details.click();
}

// The owner's own path: the row in Settings → Storage, then the flow dialog it opens.
async function driveAction(ctx, driveId, button) {
  const row = await storageRow(ctx, driveId);
  const action = row.item.getByRole('button', { exact: true, name: button });
  if (!await action.isVisible().catch(() => false)) await expandRow(row);
  await action.click();
  const dialog = ctx.page.getByRole('dialog');
  await dialog.getByRole('button', { exact: true, name: button }).click();
  return dialog;
}

// Renamed from the row's More menu. An empty name gives a drive its own label back.
export async function renameInSettings(ctx, storageId, name) {
  const row = await storageRow(ctx, storageId);
  await expandRow(row);
  await row.item.getByRole('button', { name: `More actions for ${row.name}` }).click();
  await ctx.page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = ctx.page.getByRole('dialog', { name: `Rename ${row.name}` });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 30000 });
}

async function ejectFromSettings(ctx, driveId) {
  const dialog = await driveAction(ctx, driveId, 'Eject');
  await driveReaches(ctx, driveId, ['ejected'], { minutes: 6 });
  await expect(dialog).toContainText('Safe to unplug', { timeout: 30000 });
  await dialog.getByRole('button', { exact: true, name: 'Done' }).click();
  expect(await mountOptions(ctx, driveId)).toEqual([]);
}

export async function driveCheck(ctx) {
  const { apps, driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['read-only']);
  await driveAction(ctx, driveId, 'Check drive');
  await driveReaches(ctx, driveId, ['ready'], { minutes: 12 });
  expect(await mountOptions(ctx, driveId)).toContain('rw');
  await appsRunAgain(ctx, apps);
}

// Ejected, unplugged and plugged back in, a drive needs no check.
export async function driveEject(ctx) {
  const { apps, driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await ejectFromSettings(ctx, driveId);
  await pullDrive(ctx, driveId);
  await plugDrive(ctx, driveId);
  await driveReaches(ctx, driveId, ['ready']);
  await appsRunAgain(ctx, apps);
}

// Ejected, then brought back from its row with no cable touched: the drive is
// ready read-write and its apps run on it again.
export async function useAgain(ctx) {
  const { apps, driveId } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await ejectFromSettings(ctx, driveId);
  const { item } = await storageRow(ctx, driveId);
  await item.getByRole('button', { exact: true, name: 'Use it again' }).click();
  await driveReaches(ctx, driveId, ['ready'], { minutes: 6 });
  expect(await mountOptions(ctx, driveId)).toContain('rw');
  await appsRunAgain(ctx, apps);
}

async function answers(ctx) {
  const response = await ctx.page.request.get(ctx.url('/suite-manager/api/setup/status'), { timeout: 10000 }).catch(() => null);
  return response?.ok() || false;
}

async function suiteAnswers(ctx, minutes) {
  await expect.poll(() => answers(ctx), { intervals: [5000], message: 'the suite should answer after the restart', timeout: minutes * 60000 }).toBe(true);
}

// The Hyper-V switch may lease the lab a new address when it restarts, and its Easy
// Door name follows the address: the run follows too, asking Hyper-V where it went.
async function labMoved(ctx) {
  const { env } = ctx;
  const door = env.labVm ? parseEasyDoorHost(new URL(ctx.homeUrl).hostname) : null;
  const was = door?.address;
  const now = was ? await vmAddress(env.labVm) : null;
  if (!now || now === was) return false;
  console.log(`[restart] the lab moved from ${was} to ${now}; the run follows it`);
  const follow = (url) => url.replace(easyDoorHomeHost(was, door.id), easyDoorHomeHost(now, door.id));
  ctx.homeUrl = follow(ctx.homeUrl);
  env.baseURL = follow(env.baseURL);
  if (env.labShell) env.labShell.target = env.labShell.target.replace(/@.*$/u, `@${now}`);
  return true;
}

// So the server still answering before a restart is not taken for it coming back.
async function suiteStops(ctx) {
  await expect.poll(async () => {
    const response = await ctx.page.request.get(ctx.url('/suite-manager/api/setup/status'), { timeout: 5000 }).catch(() => null);
    return !response;
  }, { intervals: [2000], message: 'the lab should go down', timeout: 120000 }).toBe(true);
}

// Run a moment later by systemd, so this SSH call returns instead of hanging on a
// host that is gone until its keep-alive gives up, by when the lab is back.
async function restartLab(ctx, command) {
  await runOnLab(ctx.env.labShell, REMEMBER_LOOPS);
  await runOnLab(ctx.env.labShell, `systemd-run --quiet --on-active=3 /bin/sh -c '${command.replaceAll("'", "'\\''")}'`);
  await suiteStops(ctx);
  let moved = false;
  await expect.poll(async () => {
    if (await answers(ctx)) return true;
    moved = await labMoved(ctx);
    return moved;
  }, { intervals: [5000], message: 'the suite should answer after the restart, at its address or the one the lab moved to', timeout: 8 * 60000 }).toBe(true);
  if (moved) {
    await suiteAnswers(ctx, 8);
    await followAddress(ctx);
  }
  await runOnLab(ctx.env.labShell, RESTORE_LOOPS);
}

// Reset on the spot with no unmount or shutdown, once what was written is on disk.
export async function powerCut(ctx) {
  const { apps, driveId, fileSystem } = await appDriveOf(ctx);
  await driveReaches(ctx, driveId, ['ready']);
  await restartLab(ctx, `${writeInFlight(driveId)}; echo b > /proc/sysrq-trigger`);
  await driveReaches(ctx, driveId, afterUncleanStates(fileSystem), { minutes: 4 });
  await appsRunAgain(ctx, apps);
}

// Uninstalled apps' folders included, everything listed before a restart is listed after.
export async function reboot(ctx) {
  const { page } = ctx;
  const open = (await listDrives(page)).filter((item) => ['ready', 'read-only'].includes(item.state)).map((item) => item.id).sort();
  const folders = async () => ((await apiJson(page, '/suite-manager/api/storage/usage')).folders || []).map((folder) => `${folder.driveId}/${folder.app}/${folder.name}`).sort();
  const before = await folders();
  await restartLab(ctx, 'systemctl reboot');
  await expect.poll(async () => (await listDrives(page)).filter((item) => ['ready', 'read-only'].includes(item.state)).map((item) => item.id).sort(), { intervals: [3000], message: 'every drive open before the restart should be open again', timeout: 240000 }).toEqual(open);
  expect(await folders()).toEqual(before);
  for (const app of (await installedPackages(page)).filter((item) => item.instance?.status === 'installed')) {
    expect(appRunning(await waitForRunning(page, app.id, { minutes: 8 })), `${app.id} should run after the restart`).toBe(true);
  }
}

export async function uninstall(ctx, id) {
  await apiJson(ctx.page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/uninstall`, { method: 'POST' });
}
