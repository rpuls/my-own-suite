import { useState } from 'react';

import { Icon, Panel, PanelHead, PanelItem, PanelList, Spinner, type IconName } from '../../components/ui';
import {
  backupDescription,
  checkpointLabel,
  destinationIconName,
  formatBytes,
  whenWords,
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
  return `${points.length} backup${points.length === 1 ? '' : 's'} · newest ${whenWords(points[0]?.createdAt || null)}${size}`;
}

// What you can go back to, one group per archive: this server's first, the one
// automatic backups go to at the top, then archives other servers made. A
// place of this server's that is unplugged is listed too, so a copy in a
// drawer is never forgotten.
function groupsOf(status: BackupStatus, views: DestinationView[]): Group[] {
  const primaryId = status.primaryDestination?.destinationId || '';
  const archiveGroups = (status.archives || []).map((archive): Group => {
    const points = status.backups.filter((backup) => backup.archiveId === archive.id);
    const from = archive.writtenBy?.hostname || 'another server';
    return {
      archive,
      icon: destinationIconName({ kind: archive.containerKind === 'object' ? 'object' : 'disk', storageKind: 'external' }),
      id: archive.id,
      inUse: archive.owner === 'this' && archive.containerId === primaryId,
      keyLine: archive.keyState === 'own' ? 'Opens with your key' : archive.keyState === 'borrowed' ? `Opens with ${from}'s key, kept here` : '',
      label: archive.owner === 'this' ? archive.containerLabel : `${archive.containerLabel} · from ${from}`,
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

// What you can go back to. Grouped by archive rather than thrown into one
// list, because "which of my places holds this" is the question the owner asks
// second and a flat list answers last. A group opens to its own points; a point
// opens to what it contains and what can be done with it.
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
          <button
            aria-expanded={isOpen}
            className="suite-bk-group-head"
            disabled={!group.readable}
            onClick={() => setOpen((current) => ({ ...current, [group.id]: !current[group.id] }))}
            type="button"
          >
            <span className={`suite-bk-chevron${isOpen ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
            <span className="suite-bk-row-icon"><Icon name={group.icon} /></span>
            <span className="suite-bk-group-name">
              <span>
                <strong>{group.label}</strong>
                {group.inUse ? <span className="suite-bk-chip">In use</span> : null}
              </span>
              <span className="suite-bk-detail">{group.summary}</span>
            </span>
            {group.keyLine ? <span className="suite-bk-group-key">{group.keyLine}</span> : null}
          </button>

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

// A restore point says what it is on one line and everything else when opened.
// One in another server's archive can be checked and restored from, but its
// notes and its restore points are that server's, so nothing here changes them.
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
      {elsewhere ? <span className="suite-bk-chip is-guest">Made by {elsewhere}</span> : null}
      <span className="suite-bk-point-size">{size}</span>
      <span className={`suite-bk-chevron${open ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
    </button>

    {open ? <div className="suite-bk-point-body">
      <p className="suite-bk-detail">{backupDescription(backup)} · Encrypted</p>
      {elsewhere ? <p className="suite-bk-detail">Made by another server. Restoring it makes this machine that server.</p> : null}

      <div className="suite-bk-point-actions">
        {checking ? <span className="suite-bk-working"><Spinner />Checking this backup. {backup.expect ? `${backup.expect.check.sentence} ${backup.expect.check.note || ''}` : 'You can leave the page; the check carries on.'}</span> : <>
          <button className="mos-btn mos-btn-primary mos-btn-sm" disabled={locked} onClick={onRestore} type="button">Restore</button>
          <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onCheck} type="button">Check it</button>
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
