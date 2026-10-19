const { AppJobs } = require('./app-jobs.cjs');

// One at a time per drive. Stopping and starting a drive's apps can outlast Caddy's
// 60 s cut, so the page reads the job back with the storage list.
const DRIVE_ACTIONS = Object.freeze(['check', 'eject', 'use']);

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

module.exports = { DRIVE_ACTIONS, DriveJobs };
