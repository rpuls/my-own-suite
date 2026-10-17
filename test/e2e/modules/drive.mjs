import { expect } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { runOnLab } from '../support/lab-shell.mjs';

// A lab without a drive Suite Manager would offer gets a FAT32 image attached as
// a loop device, which MOS treats like any drive plugged in. Formatted once and
// kept, so a later run finds the files an earlier one left on it.
const ATTACH_IMAGE = `set -e
image=/var/lib/mos-lab-drive.img
losetup -j "$image" | grep -q . && exit 0
[ -f "$image" ] || { truncate -s 2G "$image"; mkfs.vfat -F 32 -n LABDRIVE "$image" >/dev/null; }
losetup --find --show "$image"`;

async function usableDrives(page, url) {
  const answer = await apiJson(page, url).catch(() => ({ drives: [] }));
  return (answer.drives || []).filter((drive) => drive.usable);
}

export async function drive(ctx) {
  const url = ctx.url('/suite-manager/api/apps/storage/drives');
  if ((await usableDrives(ctx.page, url)).length) return;
  await runOnLab(ctx.env.labShell, ATTACH_IMAGE);
  await expect.poll(async () => (await usableDrives(ctx.page, url)).length, { message: 'the lab drive should be offered for app files', timeout: 60000 }).toBeGreaterThan(0);
}
