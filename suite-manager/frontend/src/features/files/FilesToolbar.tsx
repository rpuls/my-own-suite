import { useRef } from 'react';

import { Icon, SelectBox } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { canSelect, joinPath, openFiles, sizeOf, type FileEntry, type FilesListing } from './model';

function Breadcrumbs({ driveId, driveName, segments }: { driveId: string; driveName: string; segments: string[] }) {
  const crumbs = [{ label: driveName, path: '' }, ...segments.map((segment, index) => ({ label: segment, path: joinPath(segments.slice(0, index + 1)) }))];
  return <nav aria-label="Folders" className="suite-files-crumbs">
    {crumbs.map((crumb, index) => <span key={crumb.path || 'top'}>
      {index ? <span aria-hidden="true" className="suite-files-crumb-gap">›</span> : null}
      {index === crumbs.length - 1
        ? <strong aria-current="page">{crumb.label}</strong>
        : <a href="#folder" onClick={(event) => { event.preventDefault(); openFiles(driveId, crumb.path); }}>{crumb.label}</a>}
    </span>)}
  </nav>;
}

// Where the owner is and what they can do there: the breadcrumbs with New folder
// and Add files, or, with anything selected, the selection and what to do with it.
export function FilesToolbar({ canAdd, driveId, driveName, entries, listing, onAddFiles, onDelete, onMove, onNewFolder, onSelect, picked, segments, writable }: {
  canAdd: boolean;
  driveId: string;
  driveName: string;
  entries: FileEntry[];
  listing: FilesListing | null;
  onAddFiles: (files: File[]) => void;
  onDelete: () => void;
  onMove: () => void;
  onNewFolder: () => void;
  onSelect: (names: string[]) => void;
  picked: FileEntry[];
  segments: string[];
  writable: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectable = entries.filter((item) => canSelect(item, !writable));
  const pickedBytes = sizeOf(picked);
  const foreign = Boolean(listing && !listing.managed && segments.length);

  if (picked.length) {
    return <div className="suite-files-toolbar is-selecting" role="toolbar" aria-label="Selection">
      <SelectBox checked label="Clear selection" onChange={() => onSelect([])} />
      <strong>{picked.length} selected{pickedBytes !== null ? ` · ${formatBytes(pickedBytes)}` : ''}</strong>
      {picked.length < selectable.length ? <button className="mos-link suite-link-button" onClick={() => onSelect(selectable.map((item) => item.name))} type="button">Select all {selectable.length}</button> : null}
      <span className="suite-files-spacer" />
      {picked.some((item) => item.refusals.change) ? null : <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={onMove} type="button">Move</button>}
      <button className="mos-btn mos-btn-danger mos-btn-sm" onClick={onDelete} type="button">Delete</button>
      <button aria-label="Clear selection" className="suite-icon-button suite-files-quiet-button" onClick={() => onSelect([])} title="Clear selection" type="button"><Icon name="x" /></button>
    </div>;
  }

  return <div className="suite-files-toolbar">
    <Breadcrumbs driveId={driveId} driveName={driveName} segments={segments} />
    <span className="suite-files-spacer" />
    {listing && !listing.managed ? <span className="suite-meta">{foreign ? 'Look and download only' : listing.addRefusal}</span> : <>
      {!writable ? <span className="suite-meta">Download still works per file</span> : null}
      <button className="mos-btn mos-btn-secondary" disabled={!canAdd} onClick={onNewFolder} title={listing?.addRefusal || undefined} type="button">New folder</button>
      <button className="mos-btn mos-btn-primary" disabled={!canAdd} onClick={() => input.current?.click()} title={listing?.addRefusal || undefined} type="button"><Icon name="upload" />Add files</button>
    </>}
    <input hidden multiple onChange={(event) => { onAddFiles([...event.currentTarget.files || []]); event.currentTarget.value = ''; }} ref={input} type="file" />
  </div>;
}
