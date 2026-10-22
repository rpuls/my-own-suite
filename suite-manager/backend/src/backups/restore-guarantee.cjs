// 'verified' was earned by the recovery drills of 2026-07-20/21 and 2026-09-05/06
// (docs/decisions.md). MOS lists only restore points in archives it can read, so
// the guarantee is the archive's and the same for every restore point.
const REPOSITORY_GUARANTEE = 'verified';

function restoreGuarantee() {
  return { restoreGuarantee: REPOSITORY_GUARANTEE, restoreGuaranteeByKind: { 'restore-point': REPOSITORY_GUARANTEE } };
}

module.exports = { restoreGuarantee };
