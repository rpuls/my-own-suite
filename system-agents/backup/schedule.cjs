// Schedule arithmetic for automatic backups: when a schedule was last due, when
// it is next due, and which restore points fall outside its retention. Pure
// functions over a config object and a supplied instant, so the rules deciding
// whether a backup runs tonight are tested against a clock the test controls
// rather than by waiting for one.
//
// Times are wall-clock times in an owner-chosen zone, not the server's. A cloud
// server runs in UTC and its owner does not; "back up at 3am" has to mean 3am
// where the owner lives, or the quiet hour it was chosen for lands in the
// middle of their working day.

const FREQUENCIES = Object.freeze(['daily', 'weekly']);
const RETENTION_CHOICES = Object.freeze([0, 3, 7, 14, 30]);
const WEEKDAY_INDEX = Object.freeze({ Fri: 5, Mon: 1, Sat: 6, Sun: 0, Thu: 4, Tue: 2, Wed: 3 });
const DEFAULT_SCHEDULE = Object.freeze({ frequency: 'daily', hour: 3, keepLast: 7, minute: 0, weekday: 0 });

const formatters = new Map();

function isValidTimeZone(name) {
  if (!name || typeof name !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', second: '2-digit', timeZone, weekday: 'short', year: 'numeric' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// The wall-clock reading a zone shows at a given instant.
function wallTimeIn(timeZone, instant) {
  const parts = {};
  for (const part of zoneFormatter(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return { day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), month: Number(parts.month), second: Number(parts.second), weekday: WEEKDAY_INDEX[parts.weekday] ?? 0, year: Number(parts.year) };
}

// The instant at which a zone's clock reads the given wall time. Resolved by
// measuring the zone's offset at a first guess and reapplying it, which settles
// the case where the guess and the answer sit on opposite sides of a
// daylight-saving change. The hour that a spring-forward skips has no instant
// at all; the second pass lands on the hour after it rather than failing.
function instantOfWallTime(timeZone, { day, hour, minute, month, year }) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = new Date(target);
  for (let pass = 0; pass < 2; pass += 1) {
    const wall = wallTimeIn(timeZone, instant);
    const offset = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant.getTime();
    instant = new Date(target - offset);
  }
  return instant;
}

// Calendar-date arithmetic, done in UTC on the date components alone so that
// stepping a day never inherits a zone's offset changes.
function shiftedDate(wall, days) {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { day: shifted.getUTCDate(), month: shifted.getUTCMonth() + 1, weekday: shifted.getUTCDay(), year: shifted.getUTCFullYear() };
}

function matchesDay(schedule, date) {
  return schedule.frequency === 'weekly' ? date.weekday === schedule.weekday : true;
}

function occurrenceOn(schedule, date) {
  return instantOfWallTime(schedule.timeZone, { day: date.day, hour: schedule.hour, minute: schedule.minute, month: date.month, year: date.year });
}

function lastOccurrenceAtOrBefore(schedule, now) {
  const today = wallTimeIn(schedule.timeZone, now);
  for (let back = 0; back <= 8; back += 1) {
    const date = shiftedDate(today, -back);
    if (!matchesDay(schedule, date)) continue;
    const instant = occurrenceOn(schedule, date);
    if (instant.getTime() <= now.getTime()) return instant;
  }
  return null;
}

function nextOccurrenceAfter(schedule, from) {
  const today = wallTimeIn(schedule.timeZone, from);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const date = shiftedDate(today, ahead);
    if (!matchesDay(schedule, date)) continue;
    const instant = occurrenceOn(schedule, date);
    if (instant.getTime() > from.getTime()) return instant;
  }
  return null;
}

function instantMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

// A schedule is due when its most recent occurrence is newer than both the last
// run and the moment the schedule was set. Comparing against the occurrence
// rather than counting elapsed time is what makes a machine that was asleep at
// 3am back up once when it wakes, instead of not at all or once per missed day.
// The configuredAt floor is what stops turning the schedule on at noon from
// immediately running last night's backup.
function dueOccurrence(schedule, now) {
  if (!schedule || !schedule.enabled) return null;
  const occurrence = lastOccurrenceAtOrBefore(schedule, now);
  if (!occurrence) return null;
  const floor = Math.max(instantMs(schedule.lastRunAt), instantMs(schedule.configuredAt));
  return occurrence.getTime() > floor ? occurrence : null;
}

function integerWithin(value, low, high, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= low && parsed <= high ? parsed : fallback;
}

// Rejects only what cannot be honoured; everything else falls back to the
// current setting, then to the default. A schedule with a nonsense weekday is a
// caller bug, not something to leave an owner's backups switched off over.
//
// Where the backups go is not here: that is the primary destination, shared by
// everything that backs up on its own (`primary.cjs`).
function normalizeSchedule(input = {}, { current = null, defaultTimeZone = systemTimeZone() } = {}) {
  const base = { ...DEFAULT_SCHEDULE, ...(current || {}) };
  const enabled = input.enabled === true;
  const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : isValidTimeZone(base.timeZone) ? base.timeZone : defaultTimeZone;
  return {
    enabled,
    frequency: FREQUENCIES.includes(input.frequency) ? input.frequency : FREQUENCIES.includes(base.frequency) ? base.frequency : 'daily',
    hour: integerWithin(input.hour, 0, 23, base.hour),
    keepLast: RETENTION_CHOICES.includes(Number(input.keepLast)) ? Number(input.keepLast) : base.keepLast,
    minute: integerWithin(input.minute, 0, 59, base.minute),
    timeZone,
    weekday: integerWithin(input.weekday, 0, 6, base.weekday),
  };
}

// Whether two schedules fire at different moments. Editing retention must not
// move the next run, but changing the time must, so that a schedule moved from
// 3am to 9am at noon waits until tomorrow instead of firing the moment it is
// saved.
function timingChanged(before, after) {
  if (!before) return true;
  return ['frequency', 'hour', 'minute', 'timeZone', 'weekday'].some((field) => before[field] !== after[field]);
}

// Only backups MOS took on its own are ever pruned — the schedule's, and the
// one taken before a MOS update. A backup an owner took by hand marks a moment
// they chose, and a retention rule that deleted one would be removing the copy
// someone was counting on. Points whose origin is unrecorded, from before
// automatic backups existed, count as manual for the same reason.
// Returned oldest first, because they are deleted one at a time and a run that
// stops halfway should have removed the least useful copies.
function retentionVictims(points, keepLast) {
  if (!keepLast) return [];
  return [...points]
    .filter((point) => point.automatic === true)
    .sort((left, right) => instantMs(right.createdAt) - instantMs(left.createdAt))
    .slice(keepLast)
    .reverse();
}

module.exports = {
  DEFAULT_SCHEDULE,
  dueOccurrence,
  FREQUENCIES,
  instantOfWallTime,
  isValidTimeZone,
  lastOccurrenceAtOrBefore,
  nextOccurrenceAfter,
  normalizeSchedule,
  RETENTION_CHOICES,
  retentionVictims,
  systemTimeZone,
  timingChanged,
  wallTimeIn,
};
