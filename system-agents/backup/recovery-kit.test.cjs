// The sheet an owner is asked to keep, checked for the two failures that would
// matter on paper: a missing destination an owner can no longer look up, and a
// storage secret printed where it does not belong.

const assert = require('node:assert/strict');
const test = require('node:test');

const { generate } = require('./recovery-key.cjs');
const { recoveryKitFilename, recoveryKitText } = require('./recovery-kit.cjs');

const SECRET = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';
const KEY = generate().key;

// The kit is what is left when the server is not. It has to name the bucket
// well enough to point a new machine at it, and it must never be the place an
// owner's storage secret ends up.
test('the kit names every destination and carries no storage credential', () => {
  const kit = recoveryKitText({
    destinations: [
      { kind: 'drive', label: 'Backup USB' },
      { bucket: 'mos-backups', endpoint: 'https://s3.example.com', folder: 'home', kind: 'bucket', label: 'Backblaze B2', region: 'eu-central-003' },
    ],
    homeAddress: 'https://home.example.com/',
    hostname: 'mos-home',
    key: KEY,
    now: new Date('2026-09-07T12:00:00.000Z'),
  });

  assert.match(kit, /My Own Suite/u);
  assert.match(kit, /2026-09-07/u);
  assert.match(kit, /mos-home/u);
  assert.match(kit, /https:\/\/home\.example\.com\//u);
  assert.ok(kit.includes(KEY));
  assert.ok(kit.includes('Backup USB'));
  assert.ok(kit.includes('https://s3.example.com'));
  assert.ok(kit.includes('mos-backups'));
  assert.ok(kit.includes('home'));
  assert.ok(kit.includes('eu-central-003'));
  assert.equal(kit.includes(SECRET), false);
  assert.equal(kit.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.match(kit, /Install MOS on the replacement machine/u);
  assert.match(kit, /Enter recovery key/u);
  assert.match(kit, /Your storage provider's console holds your access key; a new key for the same bucket works too\./u);
});

test('a kit made before anything is connected still says so rather than lying', () => {
  const kit = recoveryKitText({ hostname: 'mos-home', key: KEY, now: new Date('2026-09-07T12:00:00.000Z') });
  assert.match(kit, /\(none connected yet\)/u);
  assert.ok(kit.includes(KEY));
});

test('the kit file is named for the server and the day it was made', () => {
  assert.equal(recoveryKitFilename({ hostname: 'MOS Home.local', now: new Date('2026-09-07T12:00:00.000Z') }), 'mos-recovery-kit-mos-home-local-2026-09-07.txt');
  assert.equal(recoveryKitFilename({ hostname: '', now: new Date('2026-09-07T12:00:00.000Z') }), 'mos-recovery-kit-server-2026-09-07.txt');
});

// The kit is what an owner is holding when the server will not come back, so on
// a machine whose disk this key also opens it has to say so — and on one where
// it does not, it must not claim a disk that is not encrypted.
test('a kit from a machine with an encrypted disk explains that half of the key too', () => {
  const kit = recoveryKitText({ encryptedDisk: true, hostname: 'mos-home', key: KEY, now: new Date('2026-09-17T12:00:00.000Z') });
  assert.match(kit, /also opens the encrypted disk/u);
  assert.match(kit, /security chip/u);
  assert.ok(kit.includes(KEY), 'the key itself is still on the sheet');
});

test('a kit from a machine with no vault claims no disk', () => {
  const kit = recoveryKitText({ hostname: 'mos-cloud', key: KEY, now: new Date('2026-09-17T12:00:00.000Z') });
  assert.doesNotMatch(kit, /encrypted disk/u);
});

// The sheet has to be right about how the server it came from starts, because
// an owner reading it is usually reading it at the worst moment.
test('a kit from a machine that asks for a password at startup says so', () => {
  const kit = recoveryKitText({ asksForPassword: true, encryptedDisk: true, hostname: 'mos-home', key: KEY, now: new Date('2026-09-18T12:00:00.000Z') });
  assert.match(kit, /ask for your Suite Manager password after every restart/u);
  assert.match(kit, /takes the key above instead/u);
  assert.doesNotMatch(kit, /never asks you for anything/u);
});
