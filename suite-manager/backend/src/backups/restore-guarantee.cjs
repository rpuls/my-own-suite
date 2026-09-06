// What MOS is willing to promise about restoring, derived rather than
// asserted.
//
// The 'verified' claim was earned twice. The Phase 4 recovery drills of
// 2026-07-20/21 proved same-machine and replacement-machine restore,
// database-backed and multi-GiB workloads, corruption, version, disk and
// disconnected-destination refusals, and mid-mutation power loss with
// journaled recovery. Those ran against tar bundles, so the encrypted
// repository had to earn the claim again on its own: the machine-level drills
// of 2026-09-05/06 repeated mount-liveness refusal, drive removal mid-backup,
// absence reconciliation, uid/gid and setuid fidelity, kill -9 mid-restore and
// real power loss mid-restore with journal, rescue copy, acknowledgement and
// recovery restore — plus a 15.4 GB measured restore that came back with zero
// metadata differences across 26,149 entries.
//
// A backup MOS can no longer read gets no guarantee at all rather than a
// weaker one: the honest answer about a retired-format bundle is that this
// version will not restore it.

const REPOSITORY_GUARANTEE = 'verified';
const UNREADABLE_GUARANTEE = 'unsupported';

function restoreGuaranteeFor(agentStatus) {
  const backups = Array.isArray(agentStatus?.backups) ? agentStatus.backups : [];
  const onlyUnreadable = backups.length > 0 && backups.every((backup) => backup?.restorable === false);
  return {
    restoreGuarantee: onlyUnreadable ? UNREADABLE_GUARANTEE : REPOSITORY_GUARANTEE,
    restoreGuaranteeByKind: { 'legacy-bundle': UNREADABLE_GUARANTEE, 'restore-point': REPOSITORY_GUARANTEE },
  };
}

module.exports = { REPOSITORY_GUARANTEE, restoreGuaranteeFor, UNREADABLE_GUARANTEE };
