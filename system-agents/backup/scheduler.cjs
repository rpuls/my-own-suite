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
const { isObjectDestinationId } = require('./object-destinations.cjs');

const SCHEDULE_FILENAME = 'schedule.json';
const TICK_INTERVAL_MS = 30_000;
// Retention gives up after this many ticks of not being able to start a delete,
// so a repository that stays busy leaves the schedule reporting its successful
// backup instead of claiming to still be working on it forever.
const RETENTION_ATTEMPTS = 20;
const DRIVE_ABSENT = 'The backup drive was not connected, so this backup has not run yet. MOS keeps checking and backs up as soon as the drive is back.';
const STORAGE_UNREACHABLE = 'The storage bucket could not be reached, so this backup has not run yet. MOS keeps checking and backs up as soon as it answers again.';
const SUITE_BUSY = 'Another backup or restore was running, so this backup has not started yet. MOS retries shortly.';
const UPDATE_IN_PROGRESS = 'An update is in progress, so this backup has not started yet. It runs when the update finishes.';
const NO_PRIMARY = 'No destination is set for automatic backups, so this backup has not run. Choose one under Backup & Restore.';

function isActive(job) { return Boolean(job && (job.status === 'queued' || job.status === 'running')); }

class BackupScheduler {
  constructor({ agentStateDir, createJob, destinations, log = () => {}, now = () => new Date(), primary, readJob, restorePoints, updateInProgress = async () => false }) {
    this.createJob = createJob;
    this.destinations = destinations;
    this.log = log;
    this.now = now;
    this.primary = primary;
    this.readJob = readJob;
    this.restorePoints = restorePoints;
    this.updateInProgress = updateInProgress;
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
    const schedule = {
      ...current,
      ...normalized,
      // Re-reading configuredAt on a timing change is what keeps a schedule
      // moved to a time earlier in the day from firing the moment it is saved.
      configuredAt: restarted ? nowIso : current?.configuredAt || nowIso,
      pending: normalized.enabled ? current?.pending || null : null,
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
    if (!schedule) return { ...DEFAULT_SCHEDULE, enabled: false, lastResult: null, lastRunAt: null, nextRunAt: null, running: false, timeZone: systemTimeZone(), waiting: null };
    const from = this.now();
    return {
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
    // An update restarts the host agents partway through, this one included, so
    // a backup started underneath it would be cut off mid-write. The run stays
    // owed exactly as it does for a drive in a drawer.
    if (await this.updateInProgress()) return this.recordWaiting(schedule, occurrence, UPDATE_IN_PROGRESS);
    const chosen = this.primary.read();
    if (!chosen) return this.recordWaiting(schedule, occurrence, NO_PRIMARY);
    const destination = this.primary.resolve(await this.destinations());
    // A destination that is not there is the ordinary case — a backup disk
    // lives in a drawer, a home connection drops — rather than a failure: the
    // run stays owed and starts the moment it is back, up until the next
    // occurrence replaces it.
    if (!destination) return this.recordWaiting(schedule, occurrence, isObjectDestinationId(chosen.destinationId) ? STORAGE_UNREACHABLE : DRIVE_ABSENT);
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
    // a loop against whatever is wrong. The destination goes on the pending
    // record so retention prunes the one this run actually wrote to, whatever
    // the primary is by the time it finishes.
    return this.write({
      ...schedule,
      lastRunAt: this.now().toISOString(),
      pending: { destinationId: destination.id, jobId: job.id, occurrence: occurrence.toISOString(), phase: 'backup' },
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
      // which is why it is captured here rather than when the primary is chosen.
      this.primary.rememberRepository(schedule.pending.destinationId);
      return this.prune({ ...schedule, pending: { ...schedule.pending, phase: 'retention' } });
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
      victims = retentionVictims(await this.restorePoints(schedule.pending.destinationId), schedule.keepLast);
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
    return this.write({ ...schedule, pending: { ...schedule.pending, attempts: 0, jobId: job.id, phase: 'retention' } });
  }

  settle(schedule, result) {
    return this.write({ ...schedule, lastResult: { ...result, at: this.now().toISOString() }, pending: null, waiting: null });
  }
}

module.exports = { BackupScheduler, DRIVE_ABSENT, NO_PRIMARY, SCHEDULE_FILENAME, STORAGE_UNREACHABLE, TICK_INTERVAL_MS, UPDATE_IN_PROGRESS };
