// Where a job has got to, in the owner's words, decided once — here — for
// every surface that shows it. The Backups screen and the busy page Caddy
// serves while Suite Manager is down both render what this module wrote; the
// busy page has no build step and no vocabulary of its own, so if the words
// lived anywhere else there would be two tables that drift apart within a
// release.
//
// Three things are produced from one job record:
//   - the plan: the stages a job of this kind always runs, in order, which is
//     what makes "step 4 of 9" a fact rather than a guess kept by a reader;
//   - the progress record kept in the job file (`job.progress`), which the
//     Backups screen reads through the agent's status;
//   - the public file the busy page polls, which carries only what an owner
//     is shown: sentences, counts, app display names and timestamps.

const fs = require('node:fs');
const path = require('node:path');
// The file name is Caddy's: the route that serves it is rendered from the same
// constant, so the writer and the reader cannot disagree about it.
const { PROGRESS_FILENAME } = require('../../infrastructure/control-plane-runtime.cjs');

// A job in the owner's words. The stage names the engine writes are its own
// step; these are what that step means to someone whose photos are in it.
const STAGE_WORDS = Object.freeze({
  'Checking required space': 'Checking there is room',
  'Checking the backup': 'Reading the backup',
  'Copying suite state': 'Copying your settings and accounts',
  'Deleting backup and reclaiming space': 'Removing it and freeing the space',
  'Opening the backup repository on the destination': 'Opening the backup store',
  'Preparing backup': 'Getting ready',
  'Rebuilding app runtime': 'Building your apps again',
  'Reclaiming space from an interrupted backup': 'Tidying up after a backup that stopped',
  'Restarting runtime': 'Starting your apps again',
  'Restoring app volumes': 'Putting your app data back',
  'Restoring suite state': 'Putting your settings and accounts back',
  'Saving pre-restore rescue copy': 'Saving a rescue copy of what is here now',
  'Starting restored control plane': 'Starting the restored server',
  'Stopping app runtime for a consistent snapshot': 'Pausing your apps',
  'Stopping current runtime': 'Stopping your apps',
  'Storing app volumes': 'Copying your app data',
  'Verifying restored state': 'Checking the result against the backup',
  'Writing manifest': 'Finishing up',
});

// The stages every job of a kind runs, in the order the engine runs them. A
// stage the engine adds only sometimes — reclaiming space left by an earlier
// interrupted backup — is not a step: it reports its own sentence and keeps
// the position of the step it runs inside, so the count never changes shape
// between two backups of the same suite.
const JOB_PLANS = Object.freeze({
  backup: Object.freeze(['Preparing backup', 'Checking required space', 'Opening the backup repository on the destination', 'Stopping app runtime for a consistent snapshot', 'Copying suite state', 'Storing app volumes', 'Writing manifest', 'Restarting runtime']),
  delete: Object.freeze(['Deleting backup and reclaiming space']),
  restore: Object.freeze(['Checking the backup', 'Checking required space', 'Stopping current runtime', 'Saving pre-restore rescue copy', 'Restoring suite state', 'Restoring app volumes', 'Rebuilding app runtime', 'Verifying restored state', 'Starting restored control plane']),
  validate: Object.freeze(['Checking the backup']),
});

const HEADLINES = Object.freeze({
  backup: 'Backing up your suite',
  delete: 'Deleting a backup',
  restore: 'Restoring your backup',
  validate: 'Checking a backup',
});

const COUNT_UNITS = Object.freeze({ apps: ['app', 'apps'], volumes: ['data store', 'data stores'] });

function stageSentence(stage) {
  if (!stage || stage === 'queued' || stage === 'starting') return 'Getting ready';
  return STAGE_WORDS[stage] || stage;
}

function planFor(kind) { return JOB_PLANS[kind] || []; }

function headlineFor(kind) { return HEADLINES[kind] || 'Working'; }

function minutesWords(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 45) return 'under a minute';
  const minutes = Math.max(1, seconds >= 20 * 60 ? Math.round(seconds / 300) * 5 : Math.round(seconds / 60));
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

// Progress inside one stage: which item of how many, named by its app. The
// sentence is composed here so the busy page shows exactly what the screen
// shows.
function countRecord(count) {
  if (!count || !Number.isFinite(count.total) || count.total <= 0) return null;
  const done = Math.min(count.total, Math.max(0, Number(count.done) || 0));
  const [singular, plural] = COUNT_UNITS[count.unit] || [count.unit || 'item', `${count.unit || 'item'}s`];
  const unit = count.total === 1 ? singular : plural;
  const current = count.current ? String(count.current) : null;
  const sentence = current
    ? `${current} — ${Math.min(done + 1, count.total)} of ${count.total} ${unit}`
    : `${done} of ${count.total} ${unit} done`;
  const expected = minutesWords(count.expectSeconds);
  return {
    current,
    done,
    note: current && expected ? `${current} usually takes ${expected} on this machine.` : null,
    sentence,
    total: count.total,
    unit: count.unit || 'items',
  };
}

// The progress record for a job as it stands now. `previous` is the record
// already on the job, which is what keeps a stage outside the plan at the
// step it runs inside, and keeps the start time the first stage set.
function progressFor(job, { count = null, now = new Date().toISOString() } = {}) {
  const plan = planFor(job.kind);
  const previous = job.progress && typeof job.progress === 'object' ? job.progress : null;
  const index = plan.indexOf(job.stage);
  const step = index >= 0 ? index + 1 : (previous?.step || 0);
  return {
    count: countRecord(count),
    expect: job.expect?.sentence ? { sentence: job.expect.sentence } : null,
    headline: headlineFor(job.kind),
    kind: job.kind || null,
    plan: plan.map((stage, position) => ({
      sentence: stageSentence(stage),
      state: position + 1 < step ? 'done' : position + 1 === step ? 'now' : 'next',
    })),
    sentence: stageSentence(job.stage),
    stage: job.stage || null,
    startedAt: previous?.startedAt || now,
    step,
    steps: plan.length,
    updatedAt: now,
  };
}

// When each stage began and ended, on the job itself, so the next estimate can
// be read off this machine's own history instead of a constant.
function advanceTimeline(job, stage, now = new Date().toISOString()) {
  const timeline = Array.isArray(job.timeline) ? job.timeline : [];
  const open = timeline[timeline.length - 1];
  if (open && !open.endedAt) open.endedAt = now;
  timeline.push({ endedAt: null, stage, startedAt: now });
  job.timeline = timeline;
}

function closeTimeline(job, now = new Date().toISOString()) {
  const open = Array.isArray(job.timeline) ? job.timeline[job.timeline.length - 1] : null;
  if (open && !open.endedAt) open.endedAt = now;
}

// What the busy page is allowed to know. Everything in it is a sentence, a
// count or a timestamp; the stage id, the job id, paths and volume names stay
// in the job record. The key list is the contract the test holds this to.
const PUBLIC_PROGRESS_KEYS = Object.freeze(['count', 'expect', 'headline', 'plan', 'sentence', 'startedAt', 'step', 'steps', 'updatedAt']);

function publicProgress(progress) {
  if (!progress) return null;
  return {
    count: progress.count ? { current: progress.count.current, done: progress.count.done, note: progress.count.note, sentence: progress.count.sentence, total: progress.count.total } : null,
    expect: progress.expect?.sentence ? { sentence: progress.expect.sentence } : null,
    headline: progress.headline,
    plan: (progress.plan || []).map((entry) => ({ sentence: entry.sentence, state: entry.state })),
    sentence: progress.sentence,
    startedAt: progress.startedAt,
    step: progress.step,
    steps: progress.steps,
    updatedAt: progress.updatedAt,
  };
}

// Writes the public file where Caddy serves it, and removes it when the job
// is over. Best effort both ways: the file is a courtesy to an owner watching
// a page, and a job must never fail because that page could not be told.
class ProgressPublisher {
  constructor({ dir, filename = PROGRESS_FILENAME }) {
    this.file = path.join(dir, filename);
  }

  publish(progress) {
    const record = publicProgress(progress);
    if (!record) return this.clear();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.next`;
      fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o644 });
      fs.renameSync(temp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  // `force` swallows ENOENT but not ENOTDIR, which is what a parent that is a
  // file rather than a directory raises on Linux while Windows reports ENOENT
  // for the same path. Either way nothing is published, which is what clearing
  // asked for.
  clear() {
    return [this.file, `${this.file}.next`]
      .map((file) => {
        try {
          fs.rmSync(file, { force: true });
          return true;
        } catch (error) {
          return error.code === 'ENOTDIR';
        }
      })
      .every(Boolean);
  }

  present() {
    return fs.existsSync(this.file);
  }
}

module.exports = {
  HEADLINES,
  JOB_PLANS,
  PROGRESS_FILENAME,
  PUBLIC_PROGRESS_KEYS,
  ProgressPublisher,
  STAGE_WORDS,
  advanceTimeline,
  closeTimeline,
  countRecord,
  headlineFor,
  minutesWords,
  planFor,
  progressFor,
  publicProgress,
  stageSentence,
};
