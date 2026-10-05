const { AppOperationLimitError } = require('./app-operation-limits.cjs');

// An app operation that builds for minutes runs here rather than in the request
// that asked for it. A closed tab, a phone going to sleep, or a proxy ending a silent
// request (Caddy 2.11 cuts a POST at 60 s) must not decide what the owner is told.
// The page only reads progress back. Subclasses name the steps and do the work.
class AppJobs {
  constructor({ busyMessage, failureCode, failureEvent, logger = null }) {
    this.busyMessage = busyMessage;
    this.failureCode = failureCode;
    this.failureEvent = failureEvent;
    this.logger = logger;
    this.jobs = new Map();
  }

  get(packageId) {
    const job = this.jobs.get(packageId);
    return job ? structuredClone(job) : null;
  }

  begin(packageId, input) {
    if (this.jobs.get(packageId)?.status === 'running') {
      throw new AppOperationLimitError('APP_OPERATION_IN_PROGRESS', this.busyMessage, 409);
    }
    const job = {
      error: null,
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: this.stepsFor(input).map((id) => ({ id, status: 'pending' })),
    };
    this.jobs.set(packageId, job);
    this.lastRun = this.run(packageId, job, input);
    return this.get(packageId);
  }

  async run(packageId, job, input) {
    const mark = (id, status) => { job.steps.find((item) => item.id === id).status = status; };
    try {
      await this.perform(packageId, input, mark);
      job.status = 'succeeded';
    } catch (error) {
      const failed = job.steps.find((item) => item.status === 'running');
      if (failed) failed.status = 'failed';
      job.status = 'failed';
      job.error = { code: error?.code || this.failureCode, message: error instanceof Error ? error.message : String(error) };
      this.logger?.warn?.(this.failureEvent, { code: job.error.code, packageId, step: failed?.id || null });
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}

module.exports = { AppJobs };
