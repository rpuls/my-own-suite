import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { mountOptions, plugDrive, pullDrive, REMEMBER_LOOPS, RESTORE_LOOPS, writeInFlight } from '../support/drive.mjs';
import { saveHandoverIfPending } from '../support/gates.mjs';
import { runOnLab } from '../support/lab-shell.mjs';
import { appRunning, installedPackages, waitForRunning } from '../support/packages.mjs';

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

// The owner's own path: the row in Settings → Storage, then the flow dialog it opens.
async function driveAction(ctx, driveId, button) {
  const { page } = ctx;
  const name = (await listDrives(page)).find((item) => item.id === driveId)?.name;
  const settings = ctx.url('/suite-manager/settings#set-storage');
  await page.goto(settings, { waitUntil: 'domcontentloaded' });
  // A restart can put the lab's handover gate back in front of Suite Manager.
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30000 });
  if (await saveHandoverIfPending(page)) await page.goto(settings, { waitUntil: 'domcontentloaded' });
  const item = page.locator('#set-storage .mos-panel-item').filter({ hasText: name });
  const action = item.getByRole('button', { exact: true, name: button });
  if (!await action.isVisible().catch(() => false)) await item.getByRole('button', { name: `Show details for ${name}` }).click();
  await action.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { exact: true, name: button }).click();
  return dialog;
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
  const dialog = await driveAction(ctx, driveId, 'Eject');
  await driveReaches(ctx, driveId, ['ejected'], { minutes: 6 });
  await expect(dialog).toContainText('Safe to unplug', { timeout: 30000 });
  await dialog.getByRole('button', { exact: true, name: 'Done' }).click();
  expect(await mountOptions(ctx, driveId)).toEqual([]);
  await pullDrive(ctx, driveId);
  await plugDrive(ctx, driveId);
  await driveReaches(ctx, driveId, ['ready']);
  await appsRunAgain(ctx, apps);
}

async function suiteAnswers(ctx, minutes) {
  await expect.poll(async () => {
    const response = await ctx.page.request.get(ctx.url('/suite-manager/api/setup/status'), { timeout: 10000 }).catch(() => null);
    return response?.ok() || false;
  }, { intervals: [5000], message: 'the suite should answer after the restart', timeout: minutes * 60000 }).toBe(true);
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
  await suiteAnswers(ctx, 8);
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
