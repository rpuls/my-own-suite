const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SourceCatalogCache } = require('../src/apps/source-catalog-cache.cjs');

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;

async function cache(policy = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-source-cache-'));
  const clock = { at: new Date('2026-09-27T09:00:00.000Z') };
  const instance = new SourceCatalogCache({ now: () => clock.at, policy, stateDir });
  return { clock, instance, stateDir, tick: (ms) => { clock.at = new Date(clock.at.getTime() + ms); } };
}

const onePackage = [{ id: 'x-abcdef01-notes', name: 'Notes' }];
const revision = 'b'.repeat(40);

test('a source that has never been checked is due, and one just fetched is not', async () => {
  const { instance, tick } = await cache();
  assert.equal(instance.due('src-1'), true);
  instance.put('src-1', { packages: onePackage, revision });
  assert.equal(instance.due('src-1'), false);
  tick(5 * HOUR);
  assert.equal(instance.due('src-1'), false);
  tick(2 * HOUR); // past the six-hour interval
  assert.equal(instance.due('src-1'), true);
});

// The whole point of the back-off: the git host allows about sixty unauthenticated
// requests an hour and the official catalog refresh already draws on that, so
// probing a repository that has gone away at the normal cadence is the worst
// possible use of what is left.
test('consecutive failures double the wait up to the ceiling, and a success resets it', async () => {
  const { instance, tick } = await cache({ failureBackoffCeilingMs: 4 * HOUR, failureBackoffMs: 30 * MINUTE });
  instance.put('src-1', { packages: onePackage, revision });

  const waitAfterFailure = () => {
    const before = instance.get('src-1').checkedAt;
    return Date.parse(instance.nextCheckAt('src-1')) - Date.parse(before);
  };
  instance.markFailed('src-1', { code: 'SOURCE_NOT_VISIBLE', message: 'gone' });
  assert.equal(waitAfterFailure(), 30 * MINUTE);
  instance.markFailed('src-1', { code: 'SOURCE_NOT_VISIBLE', message: 'gone' });
  assert.equal(waitAfterFailure(), HOUR);
  instance.markFailed('src-1', { code: 'SOURCE_NOT_VISIBLE', message: 'gone' });
  assert.equal(waitAfterFailure(), 2 * HOUR);
  for (let index = 0; index < 6; index += 1) instance.markFailed('src-1', { code: 'SOURCE_NOT_VISIBLE', message: 'gone' });
  assert.equal(waitAfterFailure(), 4 * HOUR); // capped

  tick(5 * HOUR);
  instance.markUnchanged('src-1');
  assert.equal(instance.get('src-1').error, null);
  assert.equal(Date.parse(instance.nextCheckAt('src-1')) - Date.parse(instance.get('src-1').checkedAt), 6 * HOUR);
});

// A rate-limited host says when its window resets. Taking it at its word beats
// guessing, but only when it is the longer wait — a reset a minute from now is no
// reason to abandon the ordinary back-off.
test('a rate-limit reset the host reported is honoured when it is the longer wait', async () => {
  const { clock, instance } = await cache({ failureBackoffMs: 10 * MINUTE });
  const resetAt = new Date(clock.at.getTime() + 45 * MINUTE).toISOString();
  instance.markFailed('src-1', { code: 'SOURCE_RATE_LIMITED', message: 'slow down', retryAt: resetAt });
  assert.equal(instance.nextCheckAt('src-1'), resetAt);

  const soon = new Date(clock.at.getTime() + MINUTE).toISOString();
  instance.markFailed('src-2', { code: 'SOURCE_RATE_LIMITED', message: 'slow down', retryAt: soon });
  assert.equal(Date.parse(instance.nextCheckAt('src-2')) - clock.at.getTime(), 10 * MINUTE); // first failure's back-off outlasts the reset
});

// The cap is the stagger. Without it, fifteen added sources all come due together
// and one Apps page load spends half the hour's budget.
test('a sweep takes the most overdue sources first and never more than the cap', async () => {
  const { instance, tick } = await cache({ maxProbesPerSweep: 2 });
  instance.put('src-old', { packages: onePackage, revision });
  tick(MINUTE);
  instance.put('src-mid', { packages: onePackage, revision });
  tick(MINUTE);
  instance.put('src-new', { packages: onePackage, revision });
  tick(7 * HOUR); // all three are now past the interval

  assert.deepEqual(instance.dueSourceIds(['src-new', 'src-mid', 'src-old']), ['src-old', 'src-mid']);
  // A never-checked source is the most overdue thing there is.
  assert.deepEqual(instance.dueSourceIds(['src-new', 'src-unseen']), ['src-unseen', 'src-new']);
});

test('a failed check keeps serving the packages the source last published', async () => {
  const { instance } = await cache();
  instance.put('src-1', { packages: onePackage, revision });
  instance.markFailed('src-1', { code: 'SOURCE_NOT_VISIBLE', message: 'The git host will not show this repository.' });
  const status = instance.status('src-1');
  assert.equal(status.packageCount, 1);
  assert.equal(status.revision, revision);
  assert.equal(status.error.code, 'SOURCE_NOT_VISIBLE');
  assert.deepEqual(instance.get('src-1').packages, onePackage);
});

test('a cache written by one process is read back by the next, and a corrupt one costs only a re-check', async () => {
  const { instance, stateDir } = await cache();
  instance.put('src-1', { packages: onePackage, revision });
  const reopened = new SourceCatalogCache({ stateDir });
  assert.deepEqual(reopened.get('src-1').packages, onePackage);
  assert.equal(reopened.get('src-1').revision, revision);

  fs.writeFileSync(path.join(stateDir, 'external-app-sources.json'), '{ this is not json');
  const recovered = new SourceCatalogCache({ stateDir });
  assert.equal(recovered.get('src-1'), null);
  assert.equal(recovered.due('src-1'), true); // never checked, so due now
});

test('forgetting a source drops its cached list', async () => {
  const { instance } = await cache();
  instance.put('src-1', { packages: onePackage, revision });
  instance.forget('src-1');
  assert.equal(instance.get('src-1'), null);
  assert.deepEqual(instance.status('src-1'), { checkedAt: null, error: null, fetchedAt: null, nextCheckAt: null, packageCount: null, revision: null });
});
