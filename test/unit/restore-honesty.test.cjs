// A restore is the one screen nobody can check against reality: the owner is
// told not to refresh, the server stops answering on purpose for the middle of
// it, and whatever the page last read stays on screen. These hold the surface
// to saying only what it can currently see.
//
// They are source assertions because the behaviour they protect is a rendering
// decision — which of two sources a panel draws from, and whether a failed poll
// reaches the screen at all — and the regression that produced them was a page
// that looked perfect while being nine minutes and six steps out of date.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backupsDir = path.join(__dirname, '..', '..', 'suite-manager', 'frontend', 'src', 'features', 'backups');
const read = (file) => fs.readFileSync(path.join(backupsDir, file), 'utf8');

test('the status poll tells the screen how it failed instead of swallowing it', () => {
  const screen = read('BackupsScreen.tsx');
  // A running MOS refusing this address is an answer, not a wait.
  assert.match(screen, /response\.status === 421/u);
  assert.match(screen, /wrong-address/u);
  // A transport failure and a non-2xx both have to land somewhere visible.
  assert.match(screen, /state: 'unreachable'/u);
  // And the silence has to be datable, or the page cannot say how long it has
  // been lying.
  assert.match(screen, /silenceWords/u);
});

test('a restore panel that cannot reach MOS reads the file Caddy serves, never its last good poll', () => {
  const screen = read('BackupsScreen.tsx');
  assert.match(screen, /\/mos-status\/progress\.json/u);
  // The choice itself: stale contact must not fall back to the job record the
  // page happens to be holding.
  assert.match(screen, /const progress = stale \? publicProgress : activeJob\?\.progress \|\| null;/u);
  // 204 means the agent is running no job, whatever this page was showing.
  assert.match(screen, /response\.status === 204/u);
});

test('the restore dialog states what happens to a carried domain and asks nothing about it', () => {
  const dialogs = read('dialogs.tsx');
  assert.match(dialogs, /carriedDomain/u);
  assert.match(dialogs, /does not come with it/u);
  // The choice that was made blind, and acted on while no screen could report
  // the result, is gone: no radio group, no plan on the request.
  assert.doesNotMatch(dialogs, /restore-address/u);
  assert.doesNotMatch(dialogs, /Move the address here/u);
  assert.doesNotMatch(read('BackupsScreen.tsx'), /restoreAddress/u);
});

test('what a restore left undone is on the page, not inside the activity list', () => {
  const screen = read('BackupsScreen.tsx');
  const aftermath = screen.indexOf('aftermath ? <Notice');
  const activity = screen.indexOf('suite-bk-activity-head');
  assert.ok(aftermath > 0, 'the aftermath notice is rendered');
  assert.ok(activity > 0, 'the activity list is rendered');
  assert.ok(aftermath < activity, 'the outstanding work comes before the collapsed history');
});
