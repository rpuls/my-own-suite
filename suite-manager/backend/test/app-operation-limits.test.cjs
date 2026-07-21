const assert = require('node:assert/strict');
const test = require('node:test');

const { AppOperationLimitError, AppOperationLimiter } = require('../src/apps/app-operation-limits.cjs');

function fixture(policy = {}) {
  let now = 10_000;
  const limiter = new AppOperationLimiter({
    now: () => now,
    policy: { download: { maxConcurrent: 2, maxPerWindow: 3, windowMs: 10_000, ...policy.download } },
  });
  return { advance: (ms) => { now += ms; }, limiter };
}

// A deferred promise lets a test hold an operation "in flight" and assert what a
// second one is allowed to do while the first has not finished.
function pending() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

test('a second update for the same app is refused while the first is still running', async () => {
  const { limiter } = fixture();
  const first = pending();
  const running = limiter.runExclusive('immich', () => first.promise);
  await assert.rejects(
    limiter.runExclusive('immich', async () => 'second'),
    (error) => error instanceof AppOperationLimitError && error.code === 'APP_OPERATION_IN_PROGRESS' && error.statusCode === 409,
  );
  first.settle('first');
  assert.equal(await running, 'first');
});

test('a different app is not blocked by an update running for another one', async () => {
  const { limiter } = fixture();
  const first = pending();
  const running = limiter.runExclusive('immich', () => first.promise);
  assert.equal(await limiter.runExclusive('seafile', async () => 'seafile'), 'seafile');
  first.settle('immich');
  await running;
});

test('an app is updatable again once its failed update releases the key', async () => {
  const { limiter } = fixture();
  await assert.rejects(limiter.runExclusive('immich', async () => { throw new Error('update failed'); }), /update failed/u);
  assert.equal(await limiter.runExclusive('immich', async () => 'retried'), 'retried');
});

test('downloads beyond the concurrency cap are refused rather than queued', async () => {
  const { limiter } = fixture();
  const held = [pending(), pending()];
  const running = held.map((item, index) => limiter.runDownload(`https://github.com/owner/repo-${index}`, () => item.promise));
  await assert.rejects(
    limiter.runDownload('https://github.com/owner/repo-3', async () => 'third'),
    (error) => error.code === 'APP_DOWNLOAD_BUSY' && error.statusCode === 429,
  );
  held.forEach((item) => item.settle('done'));
  await Promise.all(running);
  // The slot is returned when the download ends, not when the next one asks.
  assert.equal(await limiter.runDownload('https://github.com/owner/repo-3', async () => 'third'), 'third');
});

test('previewing an update and then applying it is never throttled', async () => {
  const { limiter } = fixture();
  const source = 'https://github.com/someone/notes';
  assert.equal(await limiter.runDownload(source, async () => 'preview'), 'preview');
  assert.equal(await limiter.runDownload(source, async () => 'apply'), 'apply');
});

test('one source cannot be downloaded from indefinitely inside the window', async () => {
  const { advance, limiter } = fixture();
  const source = 'https://github.com/someone/notes';
  for (let index = 0; index < 3; index += 1) await limiter.runDownload(source, async () => 'ok');
  await assert.rejects(
    limiter.runDownload(source, async () => 'blocked'),
    (error) => error.code === 'APP_DOWNLOAD_THROTTLED' && error.statusCode === 429,
  );
  // Another source is unaffected: the window is per source, not global.
  assert.equal(await limiter.runDownload('https://github.com/someone/other', async () => 'ok'), 'ok');
  advance(10_000);
  assert.equal(await limiter.runDownload(source, async () => 'ok'), 'ok');
});

test('a download that fails releases its concurrency slot rather than leaking it', async () => {
  const { limiter } = fixture();
  const source = 'https://github.com/someone/notes';
  await assert.rejects(limiter.runDownload(source, async () => { throw new Error('archive missing'); }), /archive missing/u);
  assert.equal(limiter.downloads, 0);
  // A failed attempt still counts against the window: retrying a broken source
  // in a loop is exactly what the window is there to bound.
  assert.equal(await limiter.runDownload(source, async () => 'ok'), 'ok');
  assert.equal(await limiter.runDownload(source, async () => 'ok'), 'ok');
  await assert.rejects(limiter.runDownload(source, async () => 'ok'), (error) => error.code === 'APP_DOWNLOAD_THROTTLED');
});

test('a download refused for being over the concurrency cap does not spend a window attempt', async () => {
  const { limiter } = fixture();
  const source = 'https://github.com/someone/notes';
  const held = [pending(), pending()];
  const running = held.map((item) => limiter.runDownload('https://github.com/someone/other', () => item.promise));
  await assert.rejects(limiter.runDownload(source, async () => 'blocked'), (error) => error.code === 'APP_DOWNLOAD_BUSY');
  held.forEach((item) => item.settle('done'));
  await Promise.all(running);
  // Being turned away because the host was busy is not the source's fault, so
  // it must not count toward that source's window.
  assert.equal(limiter.recentDownloads.has(source), false);
});

test('sources that go quiet do not accumulate limiter state forever', async () => {
  const { advance, limiter } = fixture();
  for (let index = 0; index < 5; index += 1) await limiter.runDownload(`https://github.com/someone/repo-${index}`, async () => 'ok');
  assert.equal(limiter.recentDownloads.size, 5);
  advance(10_000);
  await limiter.runDownload('https://github.com/someone/current', async () => 'ok');
  assert.deepEqual([...limiter.recentDownloads.keys()], ['https://github.com/someone/current']);
});
