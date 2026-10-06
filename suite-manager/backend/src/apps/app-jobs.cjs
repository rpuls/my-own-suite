const { AppOperationLimitError } = require('./app-operation-limits.cjs');

// An app operation that builds for minutes runs here rather than in the request
// that asked for it. A closed tab, a phone going to sleep, or a proxy ending a silent
// request (Caddy 2.11 cuts a POST at 60 s) must not decide what the owner is told.
// The page only reads progress back. Subclasses name the steps and do the work.
class AppJobs {
  constructor({ busyMessage, failureCode, failureEvent, logger = null, now = () => Date.now() }) {
    this.busyMessage = busyMessage;
    this.failureCode = failureCode;
    this.failureEvent = failureEvent;
    this.logger = logger;
    this.now = now;
    this.jobs = new Map();
  }

  // Elapsed by the server's clock, which the polling browser does not share.
  get(packageId) {
    const job = this.jobs.get(packageId);
    if (!job) return null;
    const copy = structuredClone(job);
    for (const step of copy.steps) {
      if (step.status === 'running') step.seconds = Math.max(0, Math.floor((this.now() - Date.parse(step.startedAt)) / 1000));
    }
    return copy;
  }

  begin(packageId, input) {
    if (this.jobs.get(packageId)?.status === 'running') {
      throw new AppOperationLimitError('APP_OPERATION_IN_PROGRESS', this.busyMessage, 409);
    }
    const job = {
      error: null,
      notice: null,
      startedAt: new Date(this.now()).toISOString(),
      status: 'running',
      steps: this.stepsFor(input).map((id) => ({ id, status: 'pending' })),
    };
    this.jobs.set(packageId, job);
    this.lastRun = this.run(packageId, job, input);
    return this.get(packageId);
  }

  // `perform` may return a `notice` about an operation that still succeeded, and a
  // `resolved` promise of true once the notice no longer holds, which clears it.
  async run(packageId, job, input) {
    const mark = (id, status) => {
      const step = job.steps.find((item) => item.id === id);
      step.status = status;
      if (status === 'running') step.startedAt = new Date(this.now()).toISOString();
    };
    try {
      const result = await this.perform(packageId, input, mark);
      job.notice = result?.notice || null;
      job.status = 'succeeded';
      if (job.notice && result.resolved) {
        this.lastFollowUp = result.resolved.then((gone) => { if (gone) job.notice = null; }, () => {});
      }
    } catch (error) {
      const failed = job.steps.find((item) => item.status === 'running');
      if (failed) failed.status = 'failed';
      job.status = 'failed';
      job.error = { code: error?.code || this.failureCode, message: error instanceof Error ? error.message : String(error) };
      this.logger?.warn?.(this.failureEvent, { code: job.error.code, packageId, step: failed?.id || null });
    } finally {
      job.finishedAt = new Date(this.now()).toISOString();
    }
  }
}

module.exports = { AppJobs };
