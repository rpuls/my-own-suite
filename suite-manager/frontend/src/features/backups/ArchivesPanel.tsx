import { useState } from 'react';

import { ActionMenu, DisclosureRow, Icon, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Spinner } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { whenWords } from '../../lib/dates';
import {
  backupDescription,
  checkpointLabel,
  destinationIconName,
  otherArchiveViews,
  placeOf,
  writtenElsewhere,
  type Archive,
  type BackupEntry,
  type BackupStatus,
  type OtherArchiveView,
} from './model';

const PAGE = 5;

type Owner = 'other' | 'this';

function groupSummary(archive: Archive, points: BackupEntry[]) {
  if (archive.keyState === 'locked') return 'Locked. Enter the recovery key of the server that made these to see and restore them.';
  if (!points.length) return 'No restore points in it yet.';
  const size = archive.storedBytes ? ` · ${formatBytes(archive.storedBytes)} in all` : '';
  return `${points.length} restore point${points.length === 1 ? '' : 's'} · newest ${whenWords(points[0]?.createdAt || null)}${size}`;
}

type ArchiveActions = {
  onErase: (view: OtherArchiveView) => void;
  onForgetKey: (view: OtherArchiveView) => void;
  onKeys: (archiveId: string, label: string) => void;
  onUnlock: (view: OtherArchiveView) => void;
};

type PointActions = {
  onCheck: (backup: BackupEntry) => void;
  onDelete: (backup: BackupEntry) => void;
  onEditNote: (backup: BackupEntry) => void;
  onRestore: (backup: BackupEntry) => void;
};

// One server's backups or every other server's, an archive to a row: where it is
// kept and what is in it, opening to its restore points. Where the backups came
// from decides only which of the two lists an archive is in.
export function ArchivesPanel({ busy, checking, onShowKey, owner, running, status, ...actions }: ArchiveActions & PointActions & {
  busy: string;
  checking: string;
  onShowKey: () => void;
  owner: Owner;
  running: boolean;
  status: BackupStatus;
}) {
  const primaryId = status.primaryDestination?.destinationId || '';
  const views = new Map(otherArchiveViews(status).map((view) => [view.id, view]));
  const archives = (status.archives || []).filter((archive) => archive.owner === owner)
    .sort((left, right) => Number(right.placeId === primaryId) - Number(left.placeId === primaryId) || String(right.newestAt || '').localeCompare(String(left.newestAt || '')));
  const pointsOf = (archive: Archive) => status.backups.filter((backup) => backup.archiveId === archive.id);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const first = archives.find((archive) => archive.keyState !== 'locked');
    return owner === 'this' && first ? { [first.id]: true } : {};
  });
  const [shown, setShown] = useState<Record<string, number>>({});
  const [openPoint, setOpenPoint] = useState('');
  const locked = Boolean(busy) || running;
  const one = archives.length === 1;

  if (owner === 'other' && !archives.length) return null;

  return <Panel className={`suite-bk-archives is-${owner}`}>
    {owner === 'this' ? <PanelHead heading="h2" title="This server's backups">
      <p className="suite-meta">Every place this server has backed up to. Open one to see what you can go back to.</p>
    </PanelHead> : <PanelHead heading="h2" title={one ? 'Backups from another server' : 'Backups from other servers'}>
      <p className="suite-meta">Found on storage connected here. Unlock {one ? 'them' : 'one'} with the recovery key of the server that made {one ? 'them' : 'it'} to restore from {one ? 'them' : 'it'}. This server never changes them.</p>
    </PanelHead>}

    {archives.length ? <PanelList>
      {archives.map((archive) => {
        const points = pointsOf(archive);
        const readable = archive.keyState !== 'locked';
        const isOpen = readable && Boolean(open[archive.id]);
        const limit = shown[archive.id] || PAGE;
        const visible = points.slice(0, limit);
        const other = views.get(archive.id) || null;
        const working = busy === `unlock:${archive.id}` || busy === `forget-key:${archive.id}`;
        const menu = owner === 'this'
          ? [{ label: 'Keys that open this', onSelect: () => actions.onKeys(archive.id, archive.placeLabel) }]
          : [
            ...archive.keyState === 'borrowed' && other ? [{ label: 'Keys that open this', onSelect: () => actions.onKeys(archive.id, archive.placeLabel) }, { label: 'Lock again', onSelect: () => actions.onForgetKey(other) }] : [],
            ...other?.erasable ? [{ label: 'Erase these backups…', onSelect: () => actions.onErase(other) }] : [],
          ];
        const trailing = <>
          {working ? <span className="suite-bk-working"><Spinner />{busy.startsWith('unlock') ? 'Unlocking' : 'Working'}</span> : null}
          {!working && !readable && other ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={() => actions.onUnlock(other)} type="button">Enter recovery key</button> : null}
          {menu.length ? <ActionMenu ariaLabel={`More for ${archive.placeLabel}`} disabled={locked} items={menu} /> : null}
        </>;
        return <PanelItem flush key={archive.id} quiet={!readable} selected={isOpen}>
          <DisclosureRow
            disabled={!readable}
            expanded={isOpen}
            icon={destinationIconName(placeOf(archive.placeKind))}
            label={`${isOpen ? 'Hide' : 'Show'} restore points on ${archive.placeLabel}`}
            onToggle={() => setOpen((current) => ({ ...current, [archive.id]: !current[archive.id] }))}
            trailing={trailing}
          >
            <span className="suite-bk-group-title">
              <strong>{archive.placeLabel}</strong>
              {owner === 'this' && archive.placeId === primaryId ? <span className="mos-chip">Automatic backups go here</span> : null}
              {owner === 'other' ? <span className="mos-pill">{readable ? 'Unlocked' : 'Locked'}</span> : null}
              {owner === 'other' && other?.from ? <span className="mos-chip mos-chip-info">From {other.from}</span> : null}
            </span>
            <span className="suite-bk-detail">{groupSummary(archive, points)}</span>
          </DisclosureRow>

          {isOpen ? <div className="suite-bk-points">
            {visible.map((backup) => <PointRow
              backup={backup}
              busy={busy}
              checking={checking === backup.path}
              key={backup.path}
              locked={locked}
              onCheck={() => actions.onCheck(backup)}
              onDelete={() => actions.onDelete(backup)}
              onEditNote={() => actions.onEditNote(backup)}
              onRestore={() => actions.onRestore(backup)}
              onToggle={() => setOpenPoint((current) => (current === backup.path ? '' : backup.path))}
              open={openPoint === backup.path}
            />)}
            {points.length > visible.length ? <button
              className="suite-bk-more"
              onClick={() => setShown((current) => ({ ...current, [archive.id]: (current[archive.id] || PAGE) + 10 }))}
              type="button"
            >Show {Math.min(10, points.length - visible.length)} more</button> : null}
          </div> : null}
        </PanelItem>;
      })}
    </PanelList> : <PanelBody>
      <p className="suite-meta">None yet. Back up now, and the place you choose is listed here with everything you can go back to.</p>
    </PanelBody>}

    {/* The key is a property of this list, so it closes it. */}
    {owner === 'this' ? <PanelBand icon="key" title="This server's recovery key opens these backups, and no others." tone="accent">
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onShowKey} type="button">
        <Icon name="eye" />
        Show key
      </button>
    </PanelBand> : null}
  </Panel>;
}

// A restore point says what it is on one line and everything else when opened. One
// in another server's archive can be verified and restored from, never changed.
function PointRow({ backup, busy, checking, locked, onCheck, onDelete, onEditNote, onRestore, onToggle, open }: {
  backup: BackupEntry;
  busy: string;
  checking: boolean;
  locked: boolean;
  onCheck: () => void;
  onDelete: () => void;
  onEditNote: () => void;
  onRestore: () => void;
  onToggle: () => void;
  open: boolean;
}) {
  const elsewhere = writtenElsewhere(backup);
  const checkpoint = checkpointLabel(backup);
  const label = backup.note ? `“${backup.note}”`
    : checkpoint ? checkpoint
    : backup.initiator === 'owner' ? 'Taken by you'
    : 'Automatic';
  const size = Number.isFinite(backup.sizeBytes ?? NaN) ? formatBytes(backup.sizeBytes as number) : '';

  return <div className="suite-bk-point">
    <button aria-expanded={open} className="suite-bk-point-head" onClick={onToggle} type="button">
      <span className={`suite-bk-dot is-${checkpoint ? 'info' : backup.initiator === 'owner' ? 'ready' : 'auto'}`} />
      <span className="suite-bk-point-when">{whenWords(backup.createdAt)}</span>
      <span className="suite-bk-point-label">{label}</span>
      {elsewhere ? <span className="mos-chip mos-chip-info">Made by {elsewhere}</span> : null}
      <span className="suite-bk-point-size">{size}</span>
      <span className={`suite-bk-chevron${open ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
    </button>

    {open ? <div className="suite-bk-point-body">
      <p className="suite-bk-detail">{backupDescription(backup)} · Encrypted</p>
      {elsewhere ? <p className="suite-bk-detail">Made by another server. Restoring it makes this server that server.</p> : null}

      <div className="suite-bk-point-actions">
        {checking ? <span className="suite-bk-working"><Spinner />Verifying this restore point. {backup.expect ? `${backup.expect.check.sentence} ${backup.expect.check.note || ''}` : 'You can leave the page; the check carries on.'}</span> : <>
          <button className="mos-btn mos-btn-primary mos-btn-sm" disabled={locked} onClick={onRestore} type="button">Restore</button>
          <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onCheck} type="button">Verify</button>
          {elsewhere ? null : <>
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onEditNote} type="button">{backup.note ? 'Edit the note' : 'Add a note'}</button>
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onDelete} type="button">
              {busy === `delete:${backup.path}` ? <><Spinner />Deleting</> : 'Delete'}
            </button>
          </>}
        </>}
      </div>
    </div> : null}
  </div>;
}
