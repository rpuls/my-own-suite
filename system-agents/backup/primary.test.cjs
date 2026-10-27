const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PrimaryDestination } = require('./primary.cjs');

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-primary-'));
  return new PrimaryDestination({ agentStateDir: dir, now: () => new Date('2026-09-09T12:00:00.000Z') });
}

test('choosing a destination records the name it had, so a drive in a drawer is still named', () => {
  const primary = world();
  primary.save({ destinationId: '1A2B-3C4D', label: 'Backup stick' });
  assert.deepEqual(primary.state(), { destinationId: '1A2B-3C4D', label: 'Backup stick', setAt: '2026-09-09T12:00:00.000Z' });
  primary.save({ destinationId: '1A2B-3C4D' });
  assert.equal(primary.state().label, 'Backup stick');
});

test('the primary is found among the destinations listed now, by the storage it is', () => {
  const primary = world();
  primary.save({ destinationId: '1A2B-3C4D', label: 'Backup stick' });
  assert.equal(primary.resolve([{ id: 'object:family' }, { id: '1A2B-3C4D', label: 'Backup stick' }]).label, 'Backup stick');
  assert.equal(primary.resolve([{ id: 'object:family' }]), null);
});

test('nothing is primary until one is chosen, and clearing it means nothing again', () => {
  const primary = world();
  assert.equal(primary.state(), null);
  assert.equal(primary.resolve([{ id: '1A2B-3C4D' }]), null);
  primary.save({ destinationId: '1A2B-3C4D' });
  primary.clear();
  assert.equal(primary.state(), null);
});
