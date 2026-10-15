const { AppJobs } = require('./app-jobs.cjs');

// The steps follow the update saga's stages as it reports them (see
// AppUpdateService.performStageUpdate): re-checking the reviewed pair, building
// the new version, switching the running app over, then recording it.
const UPDATE_STEPS = Object.freeze(['check', 'build', 'switch', 'finish']);

class AppUpdateJobs extends AppJobs {
  constructor({ logger = null, stage }) {
    super({ busyMessage: 'This app is already being updated.', failureCode: 'APP_UPDATE_STAGE_FAILED', failureEvent: 'app-update-failed', logger });
    this.stage = stage;
  }

  stepsFor() {
    return UPDATE_STEPS;
  }

  async perform(packageId, input, mark) {
    let current = 'check';
    mark(current, 'running');
    await this.stage(packageId, input, (next) => {
      mark(current, 'complete');
      mark(next, 'running');
      current = next;
    });
    mark(current, 'complete');
  }
}

module.exports = { AppUpdateJobs, UPDATE_STEPS };
