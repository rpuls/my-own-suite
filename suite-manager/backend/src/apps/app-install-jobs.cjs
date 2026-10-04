const { AppOperationLimitError } = require('./app-operation-limits.cjs');

// An install builds for minutes, so it runs here rather than in the page that
// asked for it: a closed tab, a reload or a phone going to sleep must not leave
// an app started but missing from Homepage. The page only reads progress back.
class AppInstallJobs {
  constructor({ addToHomepage, logger = null, prepare, progressOf, start }) {
    this.addToHomepage = addToHomepage;
    this.logger = logger;
    this.prepare = prepare;
    this.progressOf = progressOf;
    this.start = start;
    this.jobs = new Map();
  }

  get(packageId) {
    const job = this.jobs.get(packageId);
    return job ? structuredClone(job) : null;
  }

  begin(packageId, { config = {}, showOnHomepage = false } = {}) {
    if (this.jobs.get(packageId)?.status === 'running') {
      throw new AppOperationLimitError('APP_OPERATION_IN_PROGRESS', 'This app is already being installed.', 409);
    }
    const job = {
      error: null,
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: ['prepare', 'runtime', ...(showOnHomepage ? ['homepage'] : []), 'ready'].map((id) => ({ id, status: 'pending' })),
    };
    this.jobs.set(packageId, job);
    this.lastRun = this.run(packageId, job, config);
    return this.get(packageId);
  }

  async run(packageId, job, config) {
    const step = (id, status) => { job.steps.find((item) => item.id === id).status = status; };
    let current = 'prepare';
    try {
      step('prepare', 'running');
      const skipPrepare = this.progressOf(packageId).installed;
      await this.prepare(packageId, config);
      step('prepare', skipPrepare ? 'skipped' : 'complete');

      current = 'runtime';
      step('runtime', 'running');
      const skipRuntime = this.progressOf(packageId).runtimeApplied;
      if (!skipRuntime) await this.start(packageId);
      step('runtime', skipRuntime ? 'skipped' : 'complete');

      if (job.steps.some((item) => item.id === 'homepage')) {
        current = 'homepage';
        step('homepage', 'running');
        const skipHomepage = this.progressOf(packageId).homepageApplied;
        if (!skipHomepage) await this.addToHomepage(packageId);
        step('homepage', skipHomepage ? 'skipped' : 'complete');
      }

      step('ready', 'complete');
      job.status = 'succeeded';
    } catch (error) {
      step(current, 'failed');
      job.status = 'failed';
      job.error = { code: error?.code || 'APP_INSTALL_FAILED', message: error instanceof Error ? error.message : String(error) };
      this.logger?.warn?.('app-install-failed', { code: job.error.code, packageId, step: current });
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}

module.exports = { AppInstallJobs };
