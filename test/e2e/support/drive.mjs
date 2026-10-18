import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { runOnLab } from './lab-shell.mjs';

const { FILES_DIR, STORAGE_MOUNT_ROOT } = createRequire(import.meta.url)('../../../shared/storage-contract.cjs');

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// An app's drive used as its owner would: files copied on as if from another
// computer, then plugged back in through the same unit udev starts.
export function appDrive(ctx, appId) {
  // The install step records the drive it picked; a run carried in from another
  // asks Suite Manager, by its own address, since the tab may be showing the app.
  async function driveId() {
    if (ctx.state(appId).drive) return ctx.state(appId).drive;
    const response = await ctx.page.request.get(ctx.url('/suite-manager/api/apps/packages'));
    const app = (await response.json()).packages?.find((item) => item.id === appId);
    const drive = app?.instance?.folders?.[0]?.driveId;
    if (!drive) throw new Error(`${appId} has no folders on a drive; install it with one.`);
    return drive;
  }

  return {
    // Refused unless the drive is the mount, the same proof MOS asks before making a
    // folder, so a drive that did not open never gets a file written onto the system disk.
    async put(folder, file, name = path.basename(file)) {
      const mount = path.posix.join(STORAGE_MOUNT_ROOT, await driveId());
      const target = path.posix.join(mount, FILES_DIR, 'apps', appId, folder, name);
      await runOnLab(ctx.env.labShell, `findmnt --mountpoint ${quote(mount)} >/dev/null || { echo 'the drive is not mounted at ${mount}' >&2; exit 1; }
mkdir -p ${quote(path.posix.dirname(target))} && cat > ${quote(target)}`, { input: fs.readFileSync(file) });
      return target;
    },
    async replug() {
      await runOnLab(ctx.env.labShell, `systemctl start ${quote(`mos-storage-attach@${await driveId()}.service`)}`);
    },
  };
}

// A real disk is deleted from the kernel while mounted and rescanned back through
// udev; a loop image is copied while mounted, as a pull leaves it, and swapped in.
const PULL = `set -e
uuid="$1"; record="/var/lib/mos-lab-pulled-$uuid"
dev="$(readlink -f "/dev/disk/by-uuid/$uuid")"
node="$(readlink -f "/sys/class/block/$(basename "$dev")")"
[ -e "$node/partition" ] && node="$(dirname "$node")"
# ntfs3 marks a drive dirty at the first write since it was flushed: a write in
# flight when the cable goes, as from a writer app, after the journey's files are safe.
sync
date > "${STORAGE_MOUNT_ROOT}/$uuid/MOS-lab-unplugged.txt"
sleep 1
if [ -e "$node/device/delete" ]; then
  echo scsi > "$record"
  echo 1 > "$node/device/delete"
else
  image="$(losetup --noheadings --output BACK-FILE "$dev")"
  cp --sparse=always "$image" "$image.pulled"
  findmnt --raw --noheadings --output TARGET --source "$dev" | while read -r point; do umount --lazy "$point"; done
  losetup --detach "$dev"
  mv "$image.pulled" "$image"
  echo "loop $image" > "$record"
fi`;

const PLUG = `set -e
uuid="$1"; record="/var/lib/mos-lab-pulled-$uuid"
read -r kind image < "$record"; rm -f "$record"
if [ "$kind" = scsi ]; then
  for host in /sys/class/scsi_host/host*/scan; do echo '- - -' > "$host"; done
else
  losetup --find "$image"
  systemctl start "mos-storage-attach@$uuid.service"
fi`;

// udev never announces a loop image, so after a restart it is attached as coldplug would.
export const REMEMBER_LOOPS = `set -e
losetup --noheadings --output BACK-FILE | sort -u > /var/lib/mos-lab-loops`;

export const RESTORE_LOOPS = `set -e
[ -f /var/lib/mos-lab-loops ] || exit 0
while read -r image; do
  [ -f "$image" ] || continue
  losetup --associated "$image" | grep -q . || losetup --find "$image"
done < /var/lib/mos-lab-loops
udevadm settle
for uuid in $(lsblk --noheadings --output UUID /dev/loop* 2>/dev/null | sort -u); do
  systemctl start "mos-storage-attach@$uuid.service" || true
done`;

function withArg(script, value) {
  return `set -- ${quote(value)}\n${script}`;
}

// The same write in flight as a pull, for a power cut.
export function writeInFlight(driveId) {
  return `sync; date > ${quote(path.posix.join(STORAGE_MOUNT_ROOT, driveId, 'MOS-lab-unplugged.txt'))}; sleep 1`;
}

export function pullDrive(ctx, driveId) {
  return runOnLab(ctx.env.labShell, withArg(PULL, driveId));
}

export function plugDrive(ctx, driveId) {
  return runOnLab(ctx.env.labShell, withArg(PLUG, driveId));
}

export async function mountOptions(ctx, driveId) {
  const mount = path.posix.join(STORAGE_MOUNT_ROOT, driveId);
  return (await runOnLab(ctx.env.labShell, `findmnt --noheadings --output OPTIONS --mountpoint ${quote(mount)} || true`)).trim().split(',').filter(Boolean);
}
