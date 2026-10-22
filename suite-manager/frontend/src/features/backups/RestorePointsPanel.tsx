import { useState } from 'react';

import { DisclosureRow, Icon, Panel, PanelHead, PanelItem, PanelList, Spinner, type IconName } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { whenWords } from '../../lib/dates';
import {
  backupDescription,
  checkpointLabel,
  destinationIconName,
  placeOf,
  writtenElsewhere,
  type Archive,
  type BackupEntry,
  type BackupStatus,
  type DestinationView,
} from './model';

const PAGE = 5;

type Group = {
  archive: Archive | null;
  icon: IconName;
  id: string;
  inUse: boolean;
  keyLine: string;
  label: string;
  points: BackupEntry[];
  readable: boolean;
  summary: string;
};

function groupSummary(archive: Archive, points: BackupEntry[]) {
  if (archive.keyState === 'locked') return 'Locked — enter the other server’s recovery key to see what is kept here.';
  if (!points.length) return 'Nothing here yet. Your next backup lands here.';
  const size = archive.storedBytes ? ` · ${formatBytes(archive.storedBytes)} in all` : '';
  return `${points.length} restore point${points.length === 1 ? '' : 's'} · newest ${whenWords(points[0]?.createdAt || null)}${size}`;
}

// One group per archive: this server's first, the one automatic backups go to at
// the top, then other servers'. An unplugged place of this server's is listed too.
function groupsOf(status: BackupStatus, views: DestinationView[]): Group[] {
  const primaryId = status.primaryDestination?.destinationId || '';
  const archiveGroups = (status.archives || []).map((archive): Group => {
    const points = status.backups.filter((backup) => backup.archiveId === archive.id);
    const from = archive.writtenBy?.hostname || 'another server';
    return {
      archive,
      icon: destinationIconName(placeOf(archive.placeKind)),
      id: archive.id,
      inUse: archive.owner === 'this' && archive.placeId === primaryId,
      keyLine: archive.keyState === 'own' ? 'Opens with your key' : archive.keyState === 'borrowed' ? `Opens with ${from}'s key, kept here` : '',
      label: archive.owner === 'this' ? archive.placeLabel : `${archive.placeLabel} · from ${from}`,
      points,
      readable: archive.keyState !== 'locked',
      summary: groupSummary(archive, points),
    };
  });
  const awayGroups = views.filter((view) => view.away).map((view): Group => ({
    archive: null,
    icon: destinationIconName(view.destination),
    id: `away:${view.id}`,
    inUse: view.selected,
    keyLine: '',
    label: view.label,
    points: [],
    readable: false,
    summary: 'Not connected. Plug it in to see what is kept here.',
  }));
  const rank = (group: Group) => (group.inUse ? 0 : group.archive?.owner === 'this' ? 1 : group.archive ? 3 : 2);
  return [...archiveGroups, ...awayGroups].sort((left, right) => rank(left) - rank(right));
}

// What you can go back to, grouped by the place it is kept: "which of my places
// holds this" is the owner's second question, and a flat list answers it last.
export function RestorePointsPanel({ busy, checking, onCheck, onDelete, onEditNote, onRestore, running, status, views }: {
  busy: string;
  checking: string;
  onCheck: (backup: BackupEntry) => void;
  onDelete: (backup: BackupEntry) => void;
  onEditNote: (backup: BackupEntry) => void;
  onRestore: (backup: BackupEntry) => void;
  running: boolean;
  status: BackupStatus;
  views: DestinationView[];
}) {
  const groups = groupsOf(status, views);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const inUse = groups.find((group) => group.inUse && group.readable);
    return inUse ? { [inUse.id]: true } : {};
  });
  const [shown, setShown] = useState<Record<string, number>>({});
  const [openPoint, setOpenPoint] = useState('');
  const locked = Boolean(busy) || running;
  const anyOpen = groups.some((group) => open[group.id]);

  return <Panel>
    <PanelHead
      actions={<button
        className="mos-btn mos-btn-secondary mos-btn-sm"
        onClick={() => setOpen(anyOpen ? {} : Object.fromEntries(groups.filter((group) => group.readable).map((group) => [group.id, true])))}
        type="button"
      >{anyOpen ? 'Collapse all' : 'Open all'}</button>}
      title="Restore points"
    >
      <p className="suite-meta">Grouped by the place they are kept. Open a place to see what is in it.</p>
    </PanelHead>

    <PanelList>
      {groups.map((group) => {
        const limit = shown[group.id] || PAGE;
        const visible = group.points.slice(0, limit);
        const isOpen = group.readable && Boolean(open[group.id]);
        return <PanelItem flush key={group.id} quiet={!group.readable}>
          <DisclosureRow
            aside={group.keyLine || undefined}
            disabled={!group.readable}
            expanded={isOpen}
            icon={group.icon}
            onToggle={() => setOpen((current) => ({ ...current, [group.id]: !current[group.id] }))}
          >
            <span className="suite-bk-group-title">
              <strong>{group.label}</strong>
              {group.inUse ? <span className="mos-chip">In use</span> : null}
            </span>
            <span className="suite-bk-detail">{group.summary}</span>
          </DisclosureRow>

          {isOpen ? <div className="suite-bk-points">
            {visible.map((backup) => <PointRow
              backup={backup}
              busy={busy}
              checking={checking === backup.path}
              key={backup.path}
              locked={locked}
              onCheck={() => onCheck(backup)}
              onDelete={() => onDelete(backup)}
              onEditNote={() => onEditNote(backup)}
              onRestore={() => onRestore(backup)}
              onToggle={() => setOpenPoint((current) => (current === backup.path ? '' : backup.path))}
              open={openPoint === backup.path}
            />)}
            {group.points.length > visible.length ? <button
              className="suite-bk-more"
              onClick={() => setShown((current) => ({ ...current, [group.id]: (current[group.id] || PAGE) + 10 }))}
              type="button"
            >Show {Math.min(10, group.points.length - visible.length)} more</button> : null}
          </div> : null}
        </PanelItem>;
      })}
    </PanelList>
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
