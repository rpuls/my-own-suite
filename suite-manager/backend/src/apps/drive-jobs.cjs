const { AppJobs } = require('./app-jobs.cjs');

// One at a time per drive. Stopping and starting a drive's apps can outlast Caddy's
// 60 s cut, so the page reads the job back with the storage list.
const DRIVE_ACTIONS = Object.freeze(['check', 'eject', 'use']);
// Formatting the install stick is a job too, keyed by the device the stick is now,
// since the drive it becomes has no id until the format is done.
const STICK_JOB_PREFIX = 'stick:';
const STICK_ACTION = 'format';

function stickJobId(devicePath) { return `${STICK_JOB_PREFIX}${devicePath}`; }
function stickDevicePath(jobId) { return jobId.startsWith(STICK_JOB_PREFIX) ? jobId.slice(STICK_JOB_PREFIX.length) : null; }

class DriveJobs extends AppJobs {
  constructor({ logger = null, perform }) {
    super({ busyMessage: 'MOS is already working on this drive.', failureCode: 'APP_STORAGE_UNAVAILABLE', failureEvent: 'drive-action-failed', logger });
    this.performAction = perform;
  }

  stepsFor({ action }) {
    return [action];
  }

  async perform(driveId, { action }, mark) {
    mark(action, 'running');
    await this.performAction(driveId, action);
    mark(action, 'complete');
  }
}

module.exports = { DRIVE_ACTIONS, DriveJobs, STICK_ACTION, stickDevicePath, stickJobId };
