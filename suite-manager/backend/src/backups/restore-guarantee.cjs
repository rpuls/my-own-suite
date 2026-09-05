// What MOS is willing to promise about restoring, derived rather than
// asserted.
//
// The 'verified' claim was earned by the Phase 4 recovery drills of
// 2026-07-20/21 — same-machine and replacement-machine restores,
// database-backed and multi-GiB workloads, corruption, version, disk and
// disconnected-destination refusals, and mid-mutation power loss with
// journaled recovery. Those drills were run against tar bundles, so they
// still cover tar bundles and nothing else. Backups written into the storage
// repository are a different mechanism and have to earn the same claim
// again; until they have, saying 'verified' about them would be a promise
// MOS has not tested.

const BUNDLE_GUARANTEE = 'verified';
const REPOSITORY_GUARANTEE = 'engine-experimental';

function restoreGuaranteeFor(agentStatus) {
  const backups = Array.isArray(agentStatus?.backups) ? agentStatus.backups : [];
  const hasRestorePoints = backups.some((backup) => backup?.kind === 'restore-point');
  const onlyLegacyBundles = backups.length > 0 && !hasRestorePoints;
  return {
    // A machine holding only legacy bundles can still be told the drill-backed
    // truth about them. Anywhere else the next backup is a restore point, so
    // the weaker claim is the honest one.
    restoreGuarantee: onlyLegacyBundles ? BUNDLE_GUARANTEE : REPOSITORY_GUARANTEE,
    restoreGuaranteeByKind: { bundle: BUNDLE_GUARANTEE, 'restore-point': REPOSITORY_GUARANTEE },
  };
}

module.exports = { BUNDLE_GUARANTEE, REPOSITORY_GUARANTEE, restoreGuaranteeFor };
