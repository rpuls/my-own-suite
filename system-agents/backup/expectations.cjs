// How long a check or a restore will take, said before the owner commits and
// again while it runs — from this machine's own history where there is any,
// and as a stated range where there is none. A guess is never dressed as a
// measurement: every expectation carries its basis, and the sentence says
// which one it is.
//
// The shape of every sentence comes from one measurement. Of a 17.5-minute
// lab restore of a six-app suite, eleven minutes were rebuilding app images
// and under two were copying data. Restore time scales with how many apps
// there are and how heavy each one is, not with gigabytes — the intuitive
// "depends how much data you have" is wrong, and the copy corrects it.

const { expectedBuildSeconds } = require('../lib/app-build-timings.cjs');
const { median } = require('../lib/app-build-timings.cjs');
const { minutesWords } = require('./progress.cjs');

const GIGABYTE = 1024 ** 3;

// Per-stage durations from the finished jobs on this machine, newest first,
// as [{ seconds, sizeBytes }] for one stage of one or more job kinds.
function stageSamples(history, kinds, stage) {
  const samples = [];
  for (const job of history || []) {
    if (!kinds.includes(job?.kind) || job.status !== 'succeeded' || !Array.isArray(job.timeline)) continue;
    for (const entry of job.timeline) {
      if (entry?.stage !== stage || !entry.startedAt || !entry.endedAt) continue;
      const seconds = (Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0) samples.push({ seconds, sizeBytes: job.subject?.sizeBytes || null });
    }
  }
  return samples;
}

// The whole of a finished job of one kind, apart from the stages named.
function remainderSamples(history, kind, excluded) {
  const samples = [];
  for (const job of history || []) {
    if (job?.kind !== kind || job.status !== 'succeeded' || !Array.isArray(job.timeline)) continue;
    let seconds = 0;
    let complete = true;
    for (const entry of job.timeline) {
      if (excluded.includes(entry?.stage)) continue;
      if (!entry?.startedAt || !entry.endedAt) { complete = false; break; }
      seconds += (Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000;
    }
    if (complete && Number.isFinite(seconds)) samples.push({ seconds, sizeBytes: job.subject?.sizeBytes || null });
  }
  return samples;
}

// A stage whose cost follows the backup's size — reading every piece of it —
// is scaled by size when the history recorded one, so a check of a bigger
// backup than last time is not promised last time's minutes.
function scaledSeconds(samples, sizeBytes) {
  if (!samples.length) return null;
  const rated = samples.filter((sample) => sample.sizeBytes > 0);
  if (rated.length && sizeBytes > 0) {
    const rate = median(rated.map((sample) => sample.seconds / sample.sizeBytes));
    return Math.round(rate * sizeBytes);
  }
  return Math.round(median(samples.map((sample) => sample.seconds)));
}

function roundMinutesDown(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 10 ? Math.floor(minutes / 5) * 5 : Math.max(1, minutes);
}

function roundMinutesUp(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 10 ? Math.ceil(minutes / 5) * 5 : Math.max(1, minutes);
}

function rangeWords(lowSeconds, highSeconds) {
  const low = roundMinutesDown(lowSeconds);
  const high = Math.max(low + 1, roundMinutesUp(highSeconds));
  return `${low} to ${high} minutes`;
}

function listNames(names, limit = 3) {
  if (!names.length) return '';
  if (names.length <= limit) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - limit;
  return `${names.slice(0, limit).join(', ')} and ${rest} more`;
}

// Reading every snapshot of a backup: a check on its own, and the first stage
// of every restore. No history means a range by size, said as a range.
function checkExpectation({ history = [], sizeBytes = null } = {}) {
  const samples = stageSamples(history, ['validate', 'restore'], 'Checking the backup');
  const measured = scaledSeconds(samples, sizeBytes);
  const note = 'You can leave the page; the check carries on.';
  if (measured !== null) {
    return {
      basis: 'measured',
      high: null,
      low: null,
      note,
      seconds: measured,
      sentence: `On this machine a check of this backup takes about ${minutesWords(measured)}.`,
    };
  }
  const gigabytes = sizeBytes > 0 ? sizeBytes / GIGABYTE : null;
  const low = gigabytes === null ? 5 * 60 : 30 + gigabytes * 10;
  const high = gigabytes === null ? 15 * 60 : 60 + gigabytes * 50;
  return {
    basis: 'guess',
    high: Math.round(high),
    low: Math.round(low),
    note,
    seconds: null,
    sentence: `MOS has not timed a check on this machine yet; ${gigabytes === null ? 'one' : 'a backup this size'} usually takes ${rangeWords(low, high)}. It reads every piece of the backup, so a bigger backup or a slower connection takes longer.`,
  };
}

// A whole restore: reading the backup, the rescue copy and data copy, and the
// rebuild of every app — the part that dominates, and the only part that is
// estimated per app. Each part is measured when this machine has timed it and
// guessed when it has not, and the basis says whether every part was measured.
function restoreExpectation({ apps = [], buildTimings = {}, cpus = null, history = [], sizeBytes = null } = {}) {
  const check = checkExpectation({ history, sizeBytes });
  const names = apps.map((app) => app.displayName || app.packageId);

  const timed = [];
  const untimed = [];
  for (const app of apps) {
    const seconds = expectedBuildSeconds(buildTimings, app.packageId);
    if (seconds === null) untimed.push(app);
    else timed.push({ ...app, seconds });
  }
  timed.sort((left, right) => right.seconds - left.seconds);
  const dominant = timed[0] || null;
  const timedSeconds = timed.reduce((sum, app) => sum + app.seconds, 0);
  // An app never built here: between a small image that pulls in seconds and
  // an office suite that takes six minutes, which is the spread the lab saw.
  const untimedLow = untimed.length * 60;
  const untimedHigh = untimed.length * 360;

  const remainder = remainderSamples(history, 'restore', ['Checking the backup', 'Rebuilding app runtime']);
  const remainderMeasured = scaledSeconds(remainder, sizeBytes);
  const gigabytes = sizeBytes > 0 ? sizeBytes / GIGABYTE : 0;
  const remainderLow = remainderMeasured ?? 60 + gigabytes * 5;
  const remainderHigh = remainderMeasured ?? 180 + gigabytes * 25;

  const checkLow = check.seconds ?? check.low;
  const checkHigh = check.seconds ?? check.high;
  const low = checkLow + timedSeconds + untimedLow + remainderLow;
  const high = checkHigh + timedSeconds + untimedHigh + remainderHigh;
  const everythingMeasured = check.basis === 'measured' && untimed.length === 0 && remainderMeasured !== null;
  const nothingMeasured = check.basis !== 'measured' && timed.length === 0 && remainderMeasured === null;
  const basis = everythingMeasured ? 'measured' : nothingMeasured ? 'guess' : 'partly';

  const subject = names.length ? `Restoring ${listNames(names)}.` : 'Restoring your settings and accounts; this backup holds no apps.';
  let sentence;
  if (basis === 'measured') {
    const total = Math.round((low + high) / 2);
    sentence = `${subject} On this machine expect about ${minutesWords(total)}. Rebuilding the apps is most of it${dominant && dominant.seconds >= 60 ? `, and ${dominant.displayName || dominant.packageId} alone usually takes ${minutesWords(dominant.seconds)}` : ''}.`;
  } else if (basis === 'partly') {
    const known = dominant && dominant.seconds >= 60 ? ` ${dominant.displayName || dominant.packageId} alone usually takes ${minutesWords(dominant.seconds)} here.` : '';
    const unknown = untimed.length ? ` MOS has not yet timed ${listNames(untimed.map((app) => app.displayName || app.packageId))} on this machine.` : '';
    sentence = `${subject} Expect roughly ${rangeWords(low, high)} on this machine, most of it rebuilding the apps.${known}${unknown}`;
  } else {
    sentence = `${subject} MOS has not timed a restore on this machine yet; a suite this size usually takes ${rangeWords(low, high)} on a small server, nearly all of it rebuilding the apps.`;
  }

  return {
    apps: names,
    basis,
    cpus,
    dominant: dominant ? { displayName: dominant.displayName || dominant.packageId, packageId: dominant.packageId, seconds: dominant.seconds } : null,
    high: Math.round(high),
    low: Math.round(low),
    note: 'Restore time depends on how many apps you have and how heavy they are, not on how much data: copying the data is usually the quick part.',
    seconds: basis === 'measured' ? Math.round((low + high) / 2) : null,
    sentence,
  };
}

// The line a running job carries: the same estimate, in the words of someone
// already waiting. Computed once, when the job learns what it is working on.
function runningExpectation(kind, inputs) {
  if (kind === 'restore') {
    const expectation = restoreExpectation(inputs);
    const timing = expectation.basis === 'measured'
      ? `On this machine this usually takes about ${minutesWords(expectation.seconds)}.`
      : expectation.basis === 'partly'
        ? `On this machine expect roughly ${rangeWords(expectation.low, expectation.high)}.`
        : `MOS has not timed a restore on this machine yet; a suite this size usually takes ${rangeWords(expectation.low, expectation.high)}.`;
    return { ...expectation, sentence: `${timing} Rebuilding the apps is the slow part${expectation.dominant && expectation.dominant.seconds >= 60 ? `; ${expectation.dominant.displayName} alone usually takes ${minutesWords(expectation.dominant.seconds)}` : ''}.` };
  }
  if (kind === 'validate') {
    const expectation = checkExpectation(inputs);
    return { ...expectation, sentence: expectation.basis === 'measured' ? `On this machine this usually takes about ${minutesWords(expectation.seconds)}.` : `MOS has not timed a check on this machine yet; one usually takes ${rangeWords(expectation.low, expectation.high)}.` };
  }
  return null;
}

module.exports = { checkExpectation, listNames, rangeWords, restoreExpectation, runningExpectation, stageSamples };
