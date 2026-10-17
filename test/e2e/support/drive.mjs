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
    async put(folder, file, name = path.basename(file)) {
      const target = path.posix.join(STORAGE_MOUNT_ROOT, await driveId(), FILES_DIR, 'apps', appId, folder, name);
      await runOnLab(ctx.env.labShell, `mkdir -p ${quote(path.posix.dirname(target))} && cat > ${quote(target)}`, { input: fs.readFileSync(file) });
      return target;
    },
    async replug() {
      await runOnLab(ctx.env.labShell, `systemctl start ${quote(`mos-storage-attach@${await driveId()}.service`)}`);
    },
  };
}
