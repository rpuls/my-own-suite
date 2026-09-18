import { type VaultStartup } from '../lib/vault';
import { Icon, SecretText } from './ui';

export type RevealedRecoveryKey = { key: string; kit: string; kitFilename: string };

// The kit is a plain text file on purpose: its whole job is to survive being
// printed, photographed, or copied onto paper by hand, and a PDF would be a
// dependency for something an owner needs in the worst week of their year.
export function downloadKit(revealed: RevealedRecoveryKey) {
  const url = URL.createObjectURL(new Blob([revealed.kit], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.download = revealed.kitFilename || 'mos-recovery-kit.txt';
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const OPENS_BOTH = 'This one key opens two things: the encrypted disk in this server, and your backups on any other machine.';

// What the key opens and when it is asked for, per way the machine starts. A
// machine with no vault has a key that opens its backups and nothing else, and
// saying "your disk" there would be false; a machine with no chip is asked for
// this key at every restart, and saying "never asks" there would be too.
const SENTENCES: Record<VaultStartup, string> = {
  'no-vault': 'This key is the only thing that opens your backups on a new machine. If this server is lost and the key is lost, the backups cannot be read — not by us, not by anyone.',
  automatic: `${OPENS_BOTH} Day to day your server opens its own disk and never asks you for this key — but if its security chip ever refuses, or if this server is gone and only the backups are left, this is the only way in.`,
  password: `${OPENS_BOTH} After a restart your server asks for your Suite Manager password, never this key — but if you forget that password, if the security chip stops answering, or if this server is gone and only the backups are left, this is the only way in.`,
  'recovery-key': `${OPENS_BOTH} This machine has no security chip, so it asks you for this key after every restart — and if this server is gone and only the backups are left, it is the only way in.`,
};

// The recovery key as it appears wherever MOS shows it: at setup beside the
// server login, and again under Backup & Restore. Shared so the two screens
// cannot drift into showing one secret two ways.
export function RecoveryKeySecret({ revealed, startup }: { revealed: RevealedRecoveryKey; startup: VaultStartup }) {
  return <>
    <SecretText label="recovery key" value={revealed.key} />
    <div className="suite-bk-key-actions">
      <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => downloadKit(revealed)} type="button">
        <Icon name="upload" />Download recovery kit
      </button>
    </div>
    <p className="suite-meta">{SENTENCES[startup]}</p>
    <p className="suite-meta">
      The kit is a plain text file with the key, where your backups are kept, and the steps to get everything
      back. It holds no access key or password for your storage provider.
    </p>
  </>;
}
