import { useState } from 'react';

import { Icon, Spinner } from '../../components/ui';
import {
  backupDescription,
  checkpointLabel,
  destinationIconName,
  formatBytes,
  whenWords,
  writtenElsewhere,
  type BackupEntry,
  type BackupStatus,
  type DestinationView,
} from './model';

const PAGE = 5;

// What you can go back to. Grouped by the place it is kept rather than thrown
// into one list, because "which of my places holds this" is the question the
// owner asks second and a flat list answers last. A group opens to its own
// points; a point opens to what it contains and what can be done with it.
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
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const selected = views.find((view) => view.selected);
    return selected ? { [selected.id]: true } : {};
  });
  const [shown, setShown] = useState<Record<string, number>>({});
  const [openPoint, setOpenPoint] = useState('');
  const locked = Boolean(busy) || running;
  const anyOpen = views.some((view) => open[view.id]);

  return <section className="mos-panel suite-bk-panel">
    <div className="suite-bk-panel-head">
      <div>
        <p className="suite-bk-eyebrow">Restore points</p>
        <p className="suite-meta">Grouped by the place they are kept. Open a place to see what is in it.</p>
      </div>
      <button
        className="mos-btn mos-btn-secondary mos-btn-sm"
        onClick={() => setOpen(anyOpen ? {} : Object.fromEntries(views.filter((view) => view.selectable).map((view) => [view.id, true])))}
        type="button"
      >
        {anyOpen ? 'Collapse all' : 'Open all'}
      </button>
    </div>

    <div className="suite-bk-groups">
      {views.map((view) => {
        const points = status.backups.filter((backup) => backup.destinationId === view.id);
        const limit = shown[view.id] || PAGE;
        const visible = points.slice(0, limit);
        const isOpen = view.selectable && Boolean(open[view.id]);
        return <div className="suite-bk-group" key={view.id}>
          <button
            aria-expanded={isOpen}
            className="suite-bk-group-head"
            disabled={!view.selectable}
            onClick={() => setOpen((current) => ({ ...current, [view.id]: !current[view.id] }))}
            type="button"
          >
            <span className={`suite-bk-chevron${isOpen ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
            <span className="suite-bk-row-icon"><Icon name={destinationIconName(view.destination)} /></span>
            <span className="suite-bk-group-name">
              <span>
                <strong>{view.label}</strong>
                {view.selected ? <span className="suite-bk-chip">In use</span> : null}
              </span>
              <span className="suite-bk-detail">{groupSummary(view, points)}</span>
            </span>
            {view.selectable ? <span className="suite-bk-group-key">{view.foreign ? `Opens with your key and ${view.foreign}'s` : 'Opens with your key'}</span> : null}
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
              status={status}
            />)}
            {points.length > visible.length ? <button
              className="suite-bk-more"
              onClick={() => setShown((current) => ({ ...current, [view.id]: (current[view.id] || PAGE) + 10 }))}
              type="button"
            >Show {Math.min(10, points.length - visible.length)} more</button> : null}
            {points.length ? null : <p className="suite-bk-detail suite-bk-empty">Nothing here yet. Your next backup lands here.</p>}
          </div> : null}
        </div>;
      })}
    </div>
  </section>;
}

function groupSummary(view: DestinationView, points: BackupEntry[]) {
  if (view.destination.locked) return 'Locked — enter the other server’s recovery key to see what is kept here.';
  if (!view.selectable) return 'Not connected. Plug it in to see what is kept here.';
  if (!points.length) return 'Nothing here yet. Your next backup lands here.';
  const stored = view.destination.repository?.storedBytes;
  const size = stored ? ` · ${formatBytes(stored)} in all` : '';
  return `${points.length} backup${points.length === 1 ? '' : 's'} · newest ${whenWords(points[0]?.createdAt || null)}${size}`;
}

// A restore point says what it is on one line and everything else when opened.
// A retired-format one is a tombstone: it keeps its date so it can be told
// apart, and its only action is Delete.
function PointRow({ backup, busy, checking, locked, onCheck, onDelete, onEditNote, onRestore, onToggle, open, status }: {
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
  status: BackupStatus;
}) {
  const retired = backup.restorable === false;
  const elsewhere = writtenElsewhere(backup, status);
  const checkpoint = checkpointLabel(backup);
  const label = backup.note ? `“${backup.note}”`
    : checkpoint ? checkpoint
    : retired ? 'Too old for this version'
    : backup.initiator === 'owner' ? 'Taken by you'
    : 'Automatic';
  const size = Number.isFinite(backup.sizeBytes ?? NaN) ? formatBytes(backup.sizeBytes as number) : '';

  return <div className={`suite-bk-point${retired ? ' is-retired' : ''}`}>
    <button aria-expanded={open} className="suite-bk-point-head" onClick={onToggle} type="button">
      <span className={`suite-bk-dot is-${retired ? 'muted' : checkpoint ? 'info' : backup.initiator === 'owner' ? 'ready' : 'auto'}`} />
      <span className="suite-bk-point-when">{whenWords(backup.createdAt)}</span>
      <span className="suite-bk-point-label">{label}</span>
      {elsewhere ? <span className="suite-bk-chip is-guest">Written by {elsewhere}</span> : null}
      <span className="suite-bk-point-size">{size}</span>
      <span className={`suite-bk-chevron${open ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
    </button>

    {open ? <div className="suite-bk-point-body">
      <p className="suite-bk-detail">{backupDescription(backup)} · Encrypted</p>
      {retired ? <p className="suite-bk-detail">Too old for this version of MOS. It cannot be restored. You can delete it.</p> : null}
      {elsewhere && !retired ? <p className="suite-bk-detail">Written by another server. Restoring it replaces what is on this machine.</p> : null}

      <div className="suite-bk-point-actions">
        {checking ? <span className="suite-bk-working"><Spinner />Checking this backup — 10 to 20 minutes. You can leave the page.</span> : <>
          {retired ? null : <>
            <button className="mos-btn mos-btn-primary mos-btn-sm" disabled={locked} onClick={onRestore} type="button">Restore</button>
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onCheck} type="button">Check it</button>
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onEditNote} type="button">{backup.note ? 'Edit the note' : 'Add a note'}</button>
          </>}
          <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onDelete} type="button">
            {busy === `delete:${backup.path}` ? <><Spinner />Deleting</> : 'Delete'}
          </button>
        </>}
      </div>
    </div> : null}
  </div>;
}
