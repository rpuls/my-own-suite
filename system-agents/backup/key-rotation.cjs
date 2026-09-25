'use strict';

// Changing the recovery key, everywhere this machine can reach.
//
// Until now the key a machine was installed with was the key it died with, and
// a machine that has been restored onto other machines has handed that one key
// to every one of them. Long-lived secrets leak by accumulation: the number of
// places a key has been only ever goes up, and without a way to replace it the
// only answer to "I think my key leaked" is a fresh archive and a fresh server.
//
// Rotation normally produces the pile of printouts nobody can tell apart —
// which key opens which disk cannot be checked without the disk in front of
// you, so discarding one is unverifiable and keeping it is free. It is
// affordable here because MOS is the register: the current key is in the vault
// and on screen, so a rotation replaces the one value that matters rather than
// adding to a heap. What an owner holds on paper is a copy, never the only one.
//
// Two halves rotate differently, and the screen says so rather than implying
// they are the same:
//
// - The disk is rotated completely. LUKS wraps one master key with each
//   passphrase, so the old passphrase is removed and genuinely stops opening
//   the disk; reaching the master key itself needs the disk in hand, and an
//   attacker who has that already had the data.
// - The archive is re-wrapped, not re-encrypted. restic has no master key
//   rotation: adding a password and removing the old one leaves the repository
//   key the same, so anyone who had the old key *and* a copy of the bucket can
//   still read the snapshots that already existed. That is stated in those
//   words where the owner can act on it, not softened.

const { fingerprint, generate } = require('./recovery-key.cjs');

// Why a rotation stopped before it changed anything. Each names the state the
// machine is in, because the whole point of stopping early is that the owner's
// existing key still opens everything.
const ROTATION_REFUSALS = {
  'current-key-rejected': 'MOS could not change the key on this server\'s encrypted disk, because the key it uses now did not open it.',
  'locked': 'MOS could not change the key on this server\'s encrypted disk, because the disk was not open.',
  'own-key-unreadable': 'MOS could not change the key on this server\'s encrypted disk, because it could not read the key it uses now.',
  'vault-agent-unavailable': 'MOS could not change the key on this server\'s encrypted disk, because the part of MOS that owns that disk was not answering.',
  default: 'MOS could not change the key on this server\'s encrypted disk.',
};

function refusalSentence(reason) {
  return `${ROTATION_REFUSALS[reason] || ROTATION_REFUSALS.default} Nothing was changed: your current recovery key still opens this server and its backups.`;
}

/**
 * @param {object} options
 * @param {() => Promise<Array>} options.attached the destinations MOS can reach
 * @param {object} options.destinations the resolver, whose held answers go stale
 * @param {object} options.engine holds this machine's key and speaks to repositories
 * @param {(next: string) => Promise<object>} options.rekeyDisk the vault's half
 * @param {object} options.record what this machine remembers about its key
 */
async function rotateRecoveryKey({
  attached,
  destinations,
  engine,
  generateKey = () => generate().key,
  now = () => new Date(),
  rekeyDisk,
  record,
}) {
  // A rotation that stopped partway through is finished rather than started
  // again. Its key may already be the one the disk opens with, and generating a
  // second one here would leave the first opening a disk nothing names.
  const next = engine.stagedRecoveryKey() || generateKey();
  // Written down before anything moves to it. Between the disk and the key file
  // there is a moment where the only copy would otherwise be this function's
  // local variable, and a machine that stops there comes back with a disk whose
  // key nobody holds — not the key file, not the owner's kit, nothing but the
  // chip. The staged copy is what the resume above reads.
  engine.stageRecoveryKey(next);

  // The disk goes first, and a disk that will not follow stops the whole
  // rotation before anything else moves. The other order would leave a machine
  // whose backups want a key its own vault refuses — the one state an owner
  // cannot be talked through, because the key on their new kit would not open
  // the server it came from.
  const disk = await rekeyDisk(next);
  if (disk && disk.ok === false) {
    // The staged key stays: a refusal here is a rotation this machine still
    // owes, and the next attempt resumes the same key rather than adding one.
    return { ok: false, reason: disk.reason || 'rekey-failed', sentence: refusalSentence(disk.reason) };
  }

  engine.rotateRecoveryKey(next);
  // Every held answer about what this machine's key opens is stale at once.
  destinations.forgetAll();

  // Everything MOS can reach is carried over now, so the ordinary case — one
  // bucket, one plugged-in drive — is finished before the owner closes the
  // dialog. Probing is what carries it: the engine re-keys a repository that
  // answers to a superseded key the first time it sees one, which is also how a
  // drive that spent the rotation in a drawer catches up months later, with
  // nothing to remember and nothing for the owner to do but plug it in.
  const carried = [];
  for (const destination of await attached()) {
    const spec = destination.repositorySpec();
    // A destination opened with a key this machine was handed belongs to
    // another server. Connecting to something is not a reason to alter it.
    if (spec.password) {
      carried.push({ id: destination.id, kind: destination.kind, label: destination.label, state: 'foreign' });
      continue;
    }
    let state = 'pending';
    try {
      state = (await engine.probe(spec)).state === 'open' ? 'rotated' : 'pending';
    } catch {
      state = 'pending';
    }
    carried.push({ id: destination.id, kind: destination.kind, label: destination.label, state });
  }

  // A key the owner has just been given is a key they have not saved yet, so
  // the same gate that stood before the first backup stands again until they
  // say they have it.
  record.rotate(fingerprint(next), now());
  return {
    destinations: carried,
    key: next,
    ok: true,
    // Named separately because this is the sentence the screen has to show: a
    // copy that was not attached is not a copy that failed, it is one that
    // finishes the moment it is plugged in.
    pending: carried.filter((entry) => entry.state === 'pending'),
  };
}

module.exports = { ROTATION_REFUSALS, refusalSentence, rotateRecoveryKey };
