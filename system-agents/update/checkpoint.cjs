// The backup an update takes of the whole suite before it changes any of it.
//
// It lives beside the update queue rather than beside the backup schedule for
// the same reason the schedule lives beside the backup queue: the component
// that acts on a decision owns it. The update agent is what applies the update,
// so it is what has to hold the apply open until a restore point exists — Suite
// Manager is unprivileged and restarts partway through the apply, and could not
// be waiting on anything by the time it mattered.
//
// Nothing here performs a backup. It asks the backup agent for one through the
// ordinary POST /v1/backups every manual backup goes through, so the checkpoint
// inherits every refusal already enforced there: the one-at-a-time pipeline,
// mount liveness, the interrupted-restore block, the unacknowledged recovery
// key. The destination is named as `primary` so the backup agent resolves it —
// the one destination everything that backs up on its own writes to, found even
// when a drive came back on a different mount path.
//
// There is no switch. An update backs up first, always; the one moment a real
// choice exists is while the destination is away, and that is where the owner
// is offered it — cancel, or go on without a backup.

const POLL_INTERVAL_MS = 5_000;

// A destination that is not there, a queue that is briefly busy, and an agent
// that is restarting are all the ordinary case rather than a failure: the
// update stays owed and starts by itself the moment the way is clear. Every
// other refusal is something only the owner can clear, so it fails the update
// while nothing has been touched.
const WAITING_REASONS = Object.freeze({
  BACKUP_AGENT_UNAVAILABLE: 'MOS is waiting for the backup service before it starts the update. It starts by itself as soon as the service answers.',
  DESTINATION_ABSENT: 'The backup drive is not connected, so the update has not started yet. It starts by itself as soon as the drive is back.',
  DESTINATION_UNREACHABLE: 'The storage bucket could not be reached, so the update has not started yet. It starts by itself as soon as it answers again.',
  JOB_ACTIVE: 'A backup or restore is running, so the update has not started yet. It starts by itself as soon as that finishes.',
});

const CANCELLED = 'The update was cancelled while it was waiting to back up.';
// The stages at which nothing outside the backup queue has happened yet, so
// stopping is free. Past them the checkout, the build and the reconcile are
// under way and undoing one is a rollback, not a cancel.
const CANCELLABLE_STAGES = Object.freeze(['queued', 'taking-checkpoint', 'waiting-for-backup-destination']);
// Going on without a backup is offered only while there is nowhere to write
// one. A backup that is already running is left to finish.
const SKIPPABLE_STAGES = Object.freeze(['waiting-for-backup-destination']);

class CheckpointFailure extends Error {
  constructor(message, { output = null } = {}) {
    super(message);
    this.name = 'CheckpointFailure';
    this.output = output;
  }
}

function waitingReason(error) {
  return WAITING_REASONS[error?.code] || null;
}

function isActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

// The name the Backups screen gives the checkpoint: the release it was taken
// before, or the commit on a branch track. A check that has not run yet leaves
// it unnamed rather than guessing at a version.
function checkpointTarget(status) {
  if (!status) return '';
  if (status.track?.type === 'branch') return String(status.latestRevision || '').slice(0, 12);
  return String(status.latestRelease?.version || '');
}

// Follows the one backup this update asked for, by id: the backup agent's
// current job may already be an owner's by the time the next poll looks.
async function awaitBackupJob({ backup, decision, jobId, pollIntervalMs, sleep }) {
  for (;;) {
    await sleep(pollIntervalMs);
    if (await decision() === 'cancel') return { status: 'cancelled' };
    let job = null;
    try {
      job = (await backup.job(jobId))?.job || null;
    } catch (error) {
      if (error?.code === 'NOT_FOUND') {
        throw new CheckpointFailure('The backup taken before this update disappeared before it finished. Start the update again once the Backups screen shows the backup service is healthy.');
      }
      // The backup agent not answering says nothing about the backup it is
      // running; ask again rather than declare the checkpoint lost.
      continue;
    }
    if (isActive(job)) continue;
    if (job?.status === 'succeeded') return { backupId: jobId, status: 'succeeded' };
    throw new CheckpointFailure(job?.error || 'The backup taken before this update did not finish.', { output: (job?.logs || []).map((entry) => `${entry.at || ''} ${entry.message || ''}`.trim()).join('\n') || null });
  }
}

// Runs the checkpoint to a conclusion, reporting each state change through
// `onState` so the job record — which is what survives an agent restart — is
// always the truth about where the update is. `decision` is what the owner has
// said meanwhile: `cancel`, `skip`, or nothing. Resolves to the checkpoint
// state to record; throws CheckpointFailure when the update must not go ahead.
async function takeCheckpoint({ backup, decision = async () => null, now = () => new Date(), onState = () => {}, pollIntervalMs = POLL_INTERVAL_MS, sleep, target = '' }) {
  let waiting = null;
  for (;;) {
    const asked = await decision();
    if (asked === 'cancel') return { status: 'cancelled' };
    if (asked === 'skip') return { status: 'skipped' };
    let started = null;
    try {
      const summary = await backup.summary();
      // Nowhere to put a checkpoint is not something to wait out: a fresh
      // install has no drive and no bucket, and there is no moment at which one
      // appears on its own. The Updates screen says so before the click.
      if (!summary?.primaryDestination?.destinationId) return { status: 'skipped' };
      started = await backup.startBackup({ destinationId: 'primary', initiator: 'update', updateTarget: target });
    } catch (error) {
      const reason = waitingReason(error);
      if (!reason) throw new CheckpointFailure(error instanceof Error ? error.message : 'The backup before this update could not be started.');
      if (waiting?.reason !== reason) waiting = { reason, since: now().toISOString() };
      onState({ status: 'waiting', waiting });
      await sleep(pollIntervalMs);
      continue;
    }
    const jobId = started?.job?.id || null;
    if (!jobId) throw new CheckpointFailure('The backup service did not report a backup for this update.');
    onState({ jobId, status: 'running', waiting: null });
    return { ...await awaitBackupJob({ backup, decision, jobId, pollIntervalMs, sleep }), jobId };
  }
}

module.exports = { CANCELLABLE_STAGES, CANCELLED, CheckpointFailure, checkpointTarget, POLL_INTERVAL_MS, SKIPPABLE_STAGES, takeCheckpoint, WAITING_REASONS };
