const assert = require('node:assert/strict');
const test = require('node:test');

const { rotateRecoveryKey } = require('./key-rotation.cjs');
const { fingerprint } = require('./recovery-key.cjs');

const CURRENT = 'MOS-0000-1111-2222-3333-4444-5555-6666-7777';
const NEXT = 'MOS-9999-8888-7777-6666-5555-4444-3333-2222';

function harness(overrides = {}) {
  const calls = [];
  const state = { current: CURRENT, record: { acknowledgedAt: '2026-09-01T00:00:00Z', fingerprint: fingerprint(CURRENT) }, superseded: [] };

  const destination = (id, { kind = 'disk', label = id, password = null, probe = 'open' } = {}) => ({
    id,
    kind,
    label,
    probe,
    repositorySpec: () => ({ env: {}, localPath: id, location: id, password, secrets: [] }),
  });

  return {
    calls,
    state,
    destination,
    options: {
      attached: async () => overrides.attached ?? [],
      destinations: { forgetAll: () => calls.push(['forgetAll']) },
      engine: {
        probe: async (spec) => {
          calls.push(['probe', spec.location]);
          const match = (overrides.attached || []).find((entry) => entry.repositorySpec().location === spec.location);
          if (match?.probe === 'throw') throw new Error('the drive went away');
          return { state: match?.probe || 'open' };
        },
        recoveryKey: () => state.current,
        rotateRecoveryKey: (next) => {
          calls.push(['rotateRecoveryKey', next]);
          state.superseded.unshift(state.current);
          state.current = next;
          return next;
        },
      },
      generateKey: () => NEXT,
      now: () => new Date('2026-09-18T10:00:00.000Z'),
      rekeyDisk: async (next) => {
        calls.push(['rekeyDisk', next]);
        return overrides.disk ?? { ok: true };
      },
      record: {
        rotate: (print, at) => { calls.push(['rotate', print, at.toISOString()]); state.record = { acknowledgedAt: null, fingerprint: print }; },
      },
    },
  };
}

const named = (calls, name) => calls.filter((call) => call[0] === name);

// The order is the safety. A machine whose backups want a key its own vault
// refuses is the one state an owner cannot be talked through, because the key
// on the kit they just printed would not open the server it came from.
test('the disk is re-keyed first, and a vault that refuses stops everything', async () => {
  const fake = harness({ disk: { ok: false, reason: 'locked' } });
  const result = await rotateRecoveryKey(fake.options);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked');
  assert.match(result.sentence, /Nothing was changed/u);
  assert.match(result.sentence, /still opens this server and its backups/u);
  assert.equal(named(fake.calls, 'rotateRecoveryKey').length, 0, 'the key file is untouched');
  assert.equal(named(fake.calls, 'rotate').length, 0);
  assert.equal(fake.state.current, CURRENT);
});

test('a rotation replaces the key everywhere it can reach, and says what it reached', async () => {
  const fake = harness();
  const drive = fake.destination('/media/backup', { label: 'Backup drive' });
  const bucket = fake.destination('s3:bucket', { kind: 'object', label: 'Off-site bucket' });
  fake.options.attached = async () => [drive, bucket];
  fake.options.engine.probe = async () => ({ state: 'open' });

  const result = await rotateRecoveryKey(fake.options);

  assert.equal(result.ok, true);
  assert.equal(result.key, NEXT);
  assert.deepEqual(fake.calls[0], ['rekeyDisk', NEXT], 'the disk goes first');
  assert.deepEqual(fake.calls[1], ['rotateRecoveryKey', NEXT]);
  assert.deepEqual(named(fake.calls, 'forgetAll').length, 1, 'every held answer about what opens is stale');
  assert.deepEqual(result.destinations.map((entry) => entry.state), ['rotated', 'rotated']);
  assert.deepEqual(result.pending, []);
  assert.equal(fake.state.superseded[0], CURRENT, 'the old key is kept for copies that were not here');
});

// A drive in a drawer is not a failure. It carries the previous key until it is
// next plugged in, which the engine finishes by itself, and the owner is told
// rather than left to find out.
test('a destination that cannot be reached is reported as still holding the old key', async () => {
  const fake = harness();
  const drive = fake.destination('/media/backup', { label: 'Backup drive', probe: 'unreachable' });
  fake.options.attached = async () => [drive];
  fake.options.engine.probe = async () => ({ state: 'unreachable' });

  const result = await rotateRecoveryKey(fake.options);

  assert.equal(result.ok, true);
  assert.deepEqual(result.pending, [{ id: '/media/backup', kind: 'disk', label: 'Backup drive', state: 'pending' }]);
});

test('a destination that throws while being carried over is pending, never a failed rotation', async () => {
  const fake = harness();
  fake.options.attached = async () => [fake.destination('/media/backup')];
  fake.options.engine.probe = async () => { throw new Error('the drive went away'); };

  const result = await rotateRecoveryKey(fake.options);
  assert.equal(result.ok, true);
  assert.equal(result.pending.length, 1);
});

// Connecting to another server's archive is not a reason to alter it, and a
// rotation is the sharpest version of that: re-keying it would lock out the
// machine that owns it.
test('an archive this machine only borrows is left alone', async () => {
  const fake = harness();
  const foreign = fake.destination('s3:theirs', { kind: 'object', label: 'Their bucket', password: 'MOS-THEIR-KEY' });
  fake.options.attached = async () => [foreign];

  const result = await rotateRecoveryKey(fake.options);

  assert.deepEqual(result.destinations, [{ id: 's3:theirs', kind: 'object', label: 'Their bucket', state: 'foreign' }]);
  assert.equal(named(fake.calls, 'probe').length, 0, 'it is not even opened');
  assert.deepEqual(result.pending, []);
});

// The kit in the drawer is wrong the moment this finishes, so the gate that
// stood before the first backup stands again until the owner says they have the
// new key.
test('the new key counts as unsaved until the owner says otherwise', async () => {
  const fake = harness();
  const result = await rotateRecoveryKey(fake.options);

  assert.equal(result.ok, true);
  assert.deepEqual(named(fake.calls, 'rotate')[0], ['rotate', fingerprint(NEXT), '2026-09-18T10:00:00.000Z']);
  assert.equal(fake.state.record.acknowledgedAt, null);
});
