// The clock behind automatic backups.
//
// It lives in the backup agent rather than in a systemd timer or in Suite
// Manager, because the agent is the only component that is root, always
// running, and already owns the one-at-a-time job pipeline every backup has to
// pass through. A timer unit would put an owner-editable setting inside a
// system file that only reconciliation may rewrite, and would still have to
// re-derive the mount check, the interrupted-restore block and the queue that
// this scheduler gets by calling the same createJob every manual backup uses.
//
// It never performs a backup itself: it decides that one is due, hands it to
// the ordinary job pipeline, and watches the resulting job like any other
// caller would. Everything a scheduled backup does is therefore exactly what a
// backup an owner clicked does, including the refusals.

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_SCHEDULE, dueOccurrence, nextOccurrenceAfter, normalizeSchedule, retentionVictims, systemTimeZone, timingChanged } = require('./schedule.cjs');

const SCHEDULE_FILENAME = 'schedule.json';
const TICK_INTERVAL_MS = 30_000;
// Retention gives up after this many ticks of not being able to start a delete,
// so a repository that stays busy leaves the schedule reporting its successful
// backup instead of claiming to still be working on it forever.
const RETENTION_ATTEMPTS = 20;
const DRIVE_ABSENT = 'The backup drive was not connected, so this backup has not run yet. MOS keeps checking and backs up as soon as the drive is back.';
const SUITE_BUSY = 'Another backup or restore was running, so this backup has not started yet. MOS retries shortly.';

function isActive(job) { return Boolean(job && (job.status === 'queued' || job.status === 'running')); }

class BackupScheduler {
  constructor({ agentStateDir, createJob, destinations, log = () => {}, now = () => new Date(), readJob, repositoryId = () => null, restorePoints }) {
    this.createJob = createJob;
    this.destinations = destinations;
    this.log = log;
    this.now = now;
    this.readJob = readJob;
    this.repositoryId = repositoryId;
    this.restorePoints = restorePoints;
    this.statePath = path.join(agentStateDir, SCHEDULE_FILENAME);
    this.timer = null;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  write(schedule) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const staged = `${this.statePath}.next`;
    fs.writeFileSync(staged, `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
    fs.renameSync(staged, this.statePath);
    return schedule;
  }

  save(input) {
    const current = this.read();
    const normalized = normalizeSchedule(input, { current, defaultTimeZone: systemTimeZone() });
    const nowIso = this.now().toISOString();
    const restarted = timingChanged(current, normalized) || !current?.enabled;
    const sameDestination = current?.destinationId === normalized.destinationId;
    const schedule = {
      ...current,
      ...normalized,
      // Re-reading configuredAt on a timing change is what keeps a schedule
      // moved to a time earlier in the day from firing the moment it is saved.
      configuredAt: restarted ? nowIso : current?.configuredAt || nowIso,
      pending: normalized.enabled ? current?.pending || null : null,
      repositoryId: this.repositoryId(normalized.destinationId) || (sameDestination ? current?.repositoryId || null : null),
      updatedAt: nowIso,
      waiting: null,
    };
    return this.state(this.write(schedule));
  }

  // What the Backups screen shows: the stored settings plus the two facts an
  // owner actually wants, which is when the next one runs and what the last one
  // did. nextRunAt is computed rather than stored so it can never drift from
  // the settings it describes.
  state(schedule = this.read()) {
    if (!schedule) return { ...DEFAULT_SCHEDULE, destinationId: null, destinationLabel: null, enabled: false, lastResult: null, lastRunAt: null, nextRunAt: null, running: false, timeZone: systemTimeZone(), waiting: null };
    const from = this.now();
    return {
      destinationId: schedule.destinationId || null,
      destinationLabel: schedule.destinationLabel || null,
      enabled: schedule.enabled === true,
      frequency: schedule.frequency,
      hour: schedule.hour,
      keepLast: schedule.keepLast,
      lastResult: schedule.lastResult || null,
      lastRunAt: schedule.lastRunAt || null,
      minute: schedule.minute,
      nextRunAt: schedule.enabled ? nextOccurrenceAfter(schedule, from)?.toISOString() || null : null,
      running: Boolean(schedule.pending),
      timeZone: schedule.timeZone,
      waiting: schedule.waiting || null,
      weekday: schedule.weekday,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Resolves the schedule's drive among what is mounted right now. A drive that
  // was unplugged and reconnected can come back on a different mount path, so
  // the repository already on it identifies it when the path no longer does —
  // an identity that belongs to the backups themselves rather than to where
  // Linux happened to attach them this time.
  async scheduledDestination(schedule) {
    const mounted = await this.destinations();
    const byPath = mounted.find((destination) => destination.id === schedule.destinationId);
    if (byPath) return byPath;
    if (!schedule.repositoryId) return null;
    const matches = mounted.filter((destination) => this.repositoryId(destination.id) === schedule.repositoryId);
    return matches.length === 1 ? matches[0] : null;
  }

  recordWaiting(schedule, occurrence, reason) {
    const waiting = { occurrence: occurrence.toISOString(), reason, since: schedule.waiting?.occurrence === occurrence.toISOString() ? schedule.waiting.since : this.now().toISOString() };
    return this.write({ ...schedule, waiting });
  }

  async tick() {
    const schedule = this.read();
    if (!schedule?.enabled) return null;
    if (schedule.pending) return this.advance(schedule);
    const occurrence = dueOccurrence(schedule, this.now());
    if (!occurrence) return null;
    return this.begin(schedule, occurrence);
  }

  async begin(schedule, occurrence) {
    const destination = await this.scheduledDestination(schedule);
    // A missing drive is the ordinary case for a backup disk that lives in a
    // drawer, not a failure: the run stays owed and starts the moment the drive
    // is back, up until the next occurrence replaces it.
    if (!destination) return this.recordWaiting(schedule, occurrence, DRIVE_ABSENT);
    if (!destination.writable) return this.recordWaiting(schedule, occurrence, 'The backup drive is connected but not writable, so this backup has not run.');
    let job = null;
    try {
      job = this.createJob('backup', { destinationId: destination.id, initiator: 'schedule' });
    } catch (error) {
      return this.recordWaiting(schedule, occurrence, error?.message || SUITE_BUSY);
    }
    this.log(`Automatic backup started for ${occurrence.toISOString()}`);
    // lastRunAt moves when the run starts, not when it succeeds: a backup that
    // fails must report and wait for the next occurrence rather than retry in
    // a loop against whatever is wrong.
    return this.write({
      ...schedule,
      destinationId: destination.id,
      destinationLabel: destination.label || schedule.destinationLabel || null,
      lastRunAt: this.now().toISOString(),
      pending: { jobId: job.id, occurrence: occurrence.toISOString(), phase: 'backup' },
      repositoryId: this.repositoryId(destination.id) || schedule.repositoryId || null,
      waiting: null,
    });
  }

  async advance(schedule) {
    const job = schedule.pending.jobId ? this.readJob(schedule.pending.jobId) : null;
    if (isActive(job)) return null;
    if (schedule.pending.phase === 'backup') {
      if (!job || job.status !== 'succeeded') {
        return this.settle(schedule, { message: job?.error || 'The automatic backup did not finish. Its record is in the activity below.', status: 'failed' });
      }
      // The repository identity is only knowable once a backup has written one,
      // which is why it is captured here rather than when the schedule is set.
      const withRepository = { ...schedule, repositoryId: this.repositoryId(schedule.destinationId) || schedule.repositoryId || null };
      return this.prune({ ...withRepository, pending: { ...schedule.pending, phase: 'retention' } });
    }
    if (job && job.status !== 'succeeded') {
      return this.settle(schedule, { message: 'The backup finished, but older automatic backups could not be removed. Delete one by hand to free space.', status: 'succeeded' });
    }
    return this.prune(schedule);
  }

  // Retention runs only after a backup has just succeeded, so the suite is
  // never left with fewer copies than it started with in exchange for nothing.
  // One delete per tick: each rewrites the shared repository, and the job
  // pipeline is what serializes them against everything else.
  async prune(schedule) {
    if (!schedule.keepLast) return this.settle(schedule, { message: 'Automatic backup completed.', status: 'succeeded' });
    let victims = [];
    try {
      victims = retentionVictims(this.restorePoints(schedule.destinationId), schedule.keepLast);
    } catch {
      return this.settle(schedule, { message: 'Automatic backup completed.', status: 'succeeded' });
    }
    if (!victims.length) return this.settle(schedule, { message: 'Automatic backup completed.', status: 'succeeded' });
    let job = null;
    try {
      job = this.createJob('delete', { backupPath: victims[0].path, initiator: 'schedule' });
    } catch (error) {
      const attempts = (schedule.pending.attempts || 0) + 1;
      if (attempts >= RETENTION_ATTEMPTS) {
        return this.settle(schedule, { message: `Automatic backup completed. Older automatic backups were left in place: ${error?.message || 'the repository stayed busy.'}`, status: 'succeeded' });
      }
      return this.write({ ...schedule, pending: { ...schedule.pending, attempts } });
    }
    return this.write({ ...schedule, pending: { attempts: 0, jobId: job.id, occurrence: schedule.pending.occurrence, phase: 'retention' } });
  }

  settle(schedule, result) {
    return this.write({ ...schedule, lastResult: { ...result, at: this.now().toISOString() }, pending: null, waiting: null });
  }
}

module.exports = { BackupScheduler, DRIVE_ABSENT, SCHEDULE_FILENAME, TICK_INTERVAL_MS };
