const fs = require('node:fs');
const path = require('node:path');

// What every drive-facing agent asks lsblk, so they all read the same tree.
const LSBLK_ARGS = Object.freeze(['--json', '--bytes', '--output', 'NAME,PATH,LABEL,MODEL,TRAN,RM,TYPE,FSTYPE,UUID,PARTTYPE,SIZE,MOUNTPOINTS']);

// Resolved as POSIX because these are Linux mountpoints reported by lsblk, not
// paths on whatever machine is running the code. `path.resolve` is
// platform-dependent and turns "/" into a drive letter off Linux, which would
// silently stop recognising the system disk anywhere the agent is exercised.
function isSystemMountpoint(mountpoint) {
  const resolved = path.posix.resolve('/', String(mountpoint || ''));
  return resolved === '/' || resolved === '/boot' || resolved === '/boot/efi' || resolved === '/var' || resolved === '/var/lib' || resolved.startsWith('/var/lib/docker/');
}

// A drive formatted end to end carries no partition table, so lsblk reports a
// single `disk` with a filesystem on it and no children. That is an ordinary
// backup drive and it is also the shape a whole-disk drive comes back as after
// a restore drill, which is why refusing it made such a drive unre-attachable
// from the UI. A disk that does have partitions stays a container: its
// partitions are the candidates, and it is not one itself.
function isWholeDiskFilesystem(device) {
  return device.type === 'disk'
    && Boolean(String(device.fstype || '').trim())
    && (device.children || []).length === 0;
}

function directorySize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else { try { total += fs.lstatSync(full).size; } catch {} }
    }
  }
  return total;
}

// True for a device, or any device under it, mounted where the running system
// lives; a vault opened from the system disk counts, through its mapper child.
function holdsSystem(device) {
  const points = Array.isArray(device.mountpoints) ? device.mountpoints.filter(Boolean) : [];
  return points.some(isSystemMountpoint) || (device.children || []).some(holdsSystem);
}

module.exports = {
  LSBLK_ARGS,
  directorySize,
  holdsSystem,
  isSystemMountpoint,
  isWholeDiskFilesystem,
};
