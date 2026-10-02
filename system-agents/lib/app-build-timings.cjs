// How long each app's images took to build on this machine, written by the app
// agent every time it builds one — at install, at update, and during a restore
// — and read by whoever has to say how long the next build will take. It lives
// beside the state root rather than inside it so a restore does not import
// another machine's numbers: these describe this CPU, not the suite.
//
// Only the last few samples per package are kept. A build time is a property
// of the machine and the package version, and both change; the median of a
// short window follows them, and a single outlier (a cold cache, a busy disk)
// does not become the number an owner is told for the next year.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILD_TIMINGS_FILENAME = 'app-build-timings.json';
const SAMPLES_KEPT = 5;

function readBuildTimings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Written whole and renamed into place, so a reader never sees half a file. A
// failure to record is swallowed: the build already happened, and a timing
// that could not be saved must not turn into a failed install.
function recordBuildTiming(file, { at = new Date().toISOString(), buildSeconds = null, cpus = os.cpus().length, displayName, packageId, seconds }) {
  if (!packageId || !Number.isFinite(seconds) || seconds < 0) return null;
  const timings = readBuildTimings(file);
  const previous = timings[packageId] && typeof timings[packageId] === 'object' ? timings[packageId] : {};
  const samples = Array.isArray(previous.samples) ? previous.samples.filter((sample) => Number.isFinite(sample?.seconds)) : [];
  // `seconds` is the whole of bringing the app up, build to healthy, which is
  // what a restore pays per app; `buildSeconds` is the image build alone.
  samples.push({ at, ...(Number.isFinite(buildSeconds) ? { buildSeconds: Math.round(buildSeconds) } : {}), cpus, seconds: Math.round(seconds) });
  timings[packageId] = { displayName: displayName || previous.displayName || packageId, samples: samples.slice(-SAMPLES_KEPT) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.next`;
    fs.writeFileSync(temp, `${JSON.stringify(timings, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(temp, file);
  } catch {
    return null;
  }
  return timings[packageId];
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// The build time to expect for one package on this machine, or null when it
// has never been built here. Null is the honest answer and callers say so;
// nothing in here invents a number.
function expectedBuildSeconds(timings, packageId) {
  const entry = timings?.[packageId];
  if (!entry || !Array.isArray(entry.samples)) return null;
  return median(entry.samples.map((sample) => sample?.seconds));
}

module.exports = { BUILD_TIMINGS_FILENAME, expectedBuildSeconds, median, readBuildTimings, recordBuildTiming };
