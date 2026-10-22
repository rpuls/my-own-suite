#!/usr/bin/env node

// Started by udev, through mos-storage-attach@<uuid>.service, for every drive that
// appears with a filesystem MOS can mount. Each is mounted on sight; only a
// remembered drive has containers to restart onto the fresh mount.
const { SystemAppAdapter } = require('./system-adapter.cjs');

const driveId = process.argv[2];

new SystemAppAdapter().reattachDrive(driveId)
  .then(({ attached, restarted }) => {
    if (attached) process.stdout.write(`[mos-storage] drive ${driveId} mounted; restarted ${restarted} container(s)\n`);
  })
  .catch((error) => {
    process.stderr.write(`[mos-storage] drive ${driveId}: ${error.message}\n`);
    process.exitCode = 1;
  });
