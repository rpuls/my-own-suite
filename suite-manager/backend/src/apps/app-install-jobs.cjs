const { AppJobs } = require('./app-jobs.cjs');

// An install that ends with the app started but missing from Homepage is the
// failure a page-driven install used to leave behind.
class AppInstallJobs extends AppJobs {
  constructor({ addToHomepage, logger = null, prepare, progressOf, start }) {
    super({ busyMessage: 'This app is already being installed.', failureCode: 'APP_INSTALL_FAILED', failureEvent: 'app-install-failed', logger });
    this.addToHomepage = addToHomepage;
    this.prepare = prepare;
    this.progressOf = progressOf;
    this.start = start;
  }

  begin(packageId, { config = {}, showOnHomepage = false } = {}) {
    return super.begin(packageId, { config, showOnHomepage });
  }

  stepsFor({ showOnHomepage }) {
    return ['prepare', 'runtime', ...(showOnHomepage ? ['homepage'] : []), 'ready'];
  }

  async perform(packageId, { config, showOnHomepage }, mark) {
    mark('prepare', 'running');
    const skipPrepare = this.progressOf(packageId).installed;
    await this.prepare(packageId, config);
    mark('prepare', skipPrepare ? 'skipped' : 'complete');

    mark('runtime', 'running');
    const skipRuntime = this.progressOf(packageId).runtimeApplied;
    if (!skipRuntime) await this.start(packageId);
    mark('runtime', skipRuntime ? 'skipped' : 'complete');

    if (showOnHomepage) {
      mark('homepage', 'running');
      const skipHomepage = this.progressOf(packageId).homepageApplied;
      if (!skipHomepage) await this.addToHomepage(packageId);
      mark('homepage', skipHomepage ? 'skipped' : 'complete');
    }

    mark('ready', 'complete');
  }
}

module.exports = { AppInstallJobs };
