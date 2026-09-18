// How a machine's disk is divided between the system and the vault.
//
// The published image is one partition table decided at build time and written
// to every machine with `dd`, so the target's own disk size is not known until
// it boots. The image therefore ships small and claims the rest of the disk on
// first boot: the system partition grows to a cap, and everything past it
// becomes the LUKS2 vault that holds app data, agent state and secrets.
//
// The cap is what makes this different from the grow-to-fill it replaces. A
// system partition that swallows a 4 TB disk leaves nowhere to put the vault,
// and one sized as a fixed fraction of a 32 GB eMMC leaves a system that cannot
// hold its own swapfile. Hence a percentage between a floor and a ceiling.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// 15% of the disk, never below 12 GiB and never above 24 GiB. The floor is the
// baked image (~8 GiB) plus its swapfile plus room for a MOS update to unpack a
// second copy of the repo; the ceiling is the point past which more system
// partition buys nothing, because Docker images and app data have moved to the
// vault and the only things left growing are apt, the journal and /opt/mos.
const SYSTEM_SHARE = 0.15;
const SYSTEM_FLOOR_BYTES = 12 * GIB;
const SYSTEM_CEILING_BYTES = 24 * GIB;

// Below this a vault is not worth the partition: an owner who can store 8 GiB of
// photos has a machine MOS can protect, and one who cannot is better served by
// an honest "this disk is too small to encrypt" than by a vault that fills the
// week they start using it.
const VAULT_FLOOR_BYTES = 8 * GIB;

// Partitions are aligned to 1 MiB the way every partitioner has since 2010;
// misaligned writes cost a read-modify-write on every 4K-native disk.
const ALIGNMENT_BYTES = MIB;

function planSystemCapBytes(diskBytes) {
  const share = Math.floor(diskBytes * SYSTEM_SHARE);
  return Math.min(Math.max(share, SYSTEM_FLOOR_BYTES), SYSTEM_CEILING_BYTES);
}

function alignDown(sector, sectorsPerAlignment) {
  return Math.floor(sector / sectorsPerAlignment) * sectorsPerAlignment;
}

// GPT keeps a secondary header and partition array at the end of the disk. 33
// sectors is the 512-byte-sector figure every partitioner reserves; scaling it
// by sector size keeps the arithmetic right on 4K-native disks, where the same
// structures occupy fewer sectors and reserving 33 merely wastes a few.
function lastUsableSector({ diskBytes, sectorSize }) {
  return Math.floor(diskBytes / sectorSize) - 34;
}

/**
 * Decides what first boot should do to the disk it landed on.
 *
 * Returns one of:
 *   { action: 'none', reason }                        nothing to do, or nothing safe to do
 *   { action: 'grow-system', systemEndSector, reason } small disk: old grow-to-fill, no vault
 *   { action: 'create-vault', systemEndSector, vault } grow to the cap, vault takes the rest
 *
 * `systemEndSector` is absolute and inclusive, the way parted and sgdisk both
 * report and accept it.
 */
function planLayout({ diskBytes, lastUsableSector: reportedLastUsable, sectorSize = 512, systemPartition, partitions = [], vaultPresent = false }) {
  if (vaultPresent) return { action: 'none', reason: 'vault-exists' };
  if (!systemPartition || !Number.isInteger(systemPartition.number)) {
    return { action: 'none', reason: 'system-partition-unknown' };
  }

  // Anything living past the system partition was put there by someone else —
  // a second OS, an owner's data partition, a vault from a previous install
  // that did not identify itself. The disk is theirs; refusing is the only
  // answer that cannot destroy something MOS did not create.
  const strangers = partitions.filter((partition) => partition.number !== systemPartition.number
    && partition.startSector > systemPartition.startSector);
  if (strangers.length > 0) return { action: 'none', reason: 'unrecognised-partitions-after-system' };

  const sectorsPerAlignment = Math.max(1, Math.floor(ALIGNMENT_BYTES / sectorSize));
  // The partition table's own last usable LBA when the caller has it, because a
  // table that reserves more than the standard 33 sectors knows better than
  // this arithmetic does. The caller has fitted the table to the disk first;
  // an image's table otherwise ends where the build's disk did, and the
  // arithmetic below would read that as a disk that is already full.
  const lastUsable = Number.isInteger(reportedLastUsable)
    ? Math.min(reportedLastUsable, lastUsableSector({ diskBytes, sectorSize }))
    : lastUsableSector({ diskBytes, sectorSize });
  if (lastUsable <= systemPartition.endSector) return { action: 'none', reason: 'disk-already-full' };

  const capSectors = Math.floor(planSystemCapBytes(diskBytes) / sectorSize);
  const cappedEnd = alignDown(systemPartition.startSector + capSectors, sectorsPerAlignment) - 1;

  // Never shrink. A system partition already larger than the cap belongs to a
  // machine that grew to fill its disk under the previous layout, and taking
  // sectors back from a mounted filesystem is how installers eat people's data.
  const systemEndSector = Math.max(cappedEnd, systemPartition.endSector);

  const vaultStartSector = alignDown(systemEndSector + 1 + sectorsPerAlignment, sectorsPerAlignment);
  const vaultBytes = (lastUsable - vaultStartSector + 1) * sectorSize;
  if (vaultBytes < VAULT_FLOOR_BYTES) {
    if (systemPartition.endSector >= lastUsable) return { action: 'none', reason: 'disk-already-full' };
    return { action: 'grow-system', systemEndSector: lastUsable, reason: 'disk-too-small-for-vault' };
  }

  return {
    action: 'create-vault',
    systemEndSector,
    vault: { startSector: vaultStartSector, endSector: lastUsable, bytes: vaultBytes },
    reason: 'ok',
  };
}

module.exports = {
  GIB,
  SYSTEM_CEILING_BYTES,
  SYSTEM_FLOOR_BYTES,
  VAULT_FLOOR_BYTES,
  planLayout,
  planSystemCapBytes,
};
