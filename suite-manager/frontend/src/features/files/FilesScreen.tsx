import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';

import { ActionMenu, Icon, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, ProgressBar, SelectBox, Spinner, Tooltip } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { STORAGE_SETTINGS_PATH, joinNames, openStorageSettings, stateLabel, useStorage, type StorageEntry } from '../storage/model';
import { DeleteDialog, MoveDialog, NameDialog } from './FilesDialogs';
import {
  browseReason,
  createFolder,
  deleteEntries,
  downloadHref,
  entryFacts,
  filesLocation,
  itemsLabel,
  joinPath,
  listFiles,
  moveEntries,
  openFiles,
  renameEntry,
  filesLabel,
  sizeOf,
  type FileEntry,
  type FilesListing,
  type Leftover,
} from './model';
import { useUploads, type Interruption, type UploadItem } from './uploads';

type Flow =
  | { kind: 'folder' }
  | { entry: FileEntry; from: string; kind: 'rename' }
  | { entries: FileEntry[]; from: string; kind: 'delete' | 'move' };

function useLocation() {
  const [location, setLocation] = useState(() => filesLocation() || { driveId: '', path: '' });
  useEffect(() => {
    const update = () => { const next = filesLocation(); if (next) setLocation(next); };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return location;
}

function download(driveId: string, path: string) {
  const link = document.createElement('a');
  link.href = downloadHref(driveId, path);
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

function leftoverEntry(leftover: Leftover): FileEntry {
  return { bytes: leftover.bytes, items: null, kind: 'folder', locked: null, modifiedAt: '', name: leftover.name };
}

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

function UploadRow({ item, onStop }: { item: UploadItem; onStop: () => void }) {
  const icon = item.status === 'added' ? 'check' : item.status === 'failed' ? 'x' : 'upload';
  const facts = item.status === 'added'
    ? `Added · ${formatBytes(item.file.size)}`
    : item.status === 'failed'
      ? item.error
      : item.status === 'waiting'
        ? `Waiting · ${formatBytes(item.file.size)}`
        : `${formatBytes(item.sent)} of ${formatBytes(item.file.size)}${item.speed ? ` · ${formatBytes(item.speed)}/s` : ''}`;
  return <PanelItem className={`suite-files-upload is-${item.status}`}>
    <div className="suite-files-upload-line">
      <span className="suite-files-upload-icon"><Icon name={icon} /></span>
      <span className="suite-files-name">{item.file.name}</span>
      <span className="suite-meta">{facts}</span>
      {item.status === 'waiting' || item.status === 'sending' ? <button aria-label={`Stop adding ${item.file.name}`} className="suite-icon-button suite-files-quiet-button" onClick={onStop} title="Stop" type="button"><Icon name="x" /></button> : null}
    </div>
    {item.status === 'sending' ? <ProgressBar label={`${item.file.name} sent`} value={item.file.size ? item.sent / item.file.size : 1} /> : null}
  </PanelItem>;
}

function InterruptionNotice({ kind }: { kind: Interruption }) {
  if (kind === 'connection') return <Notice title="Connection lost — retrying"><p>The upload continues where it left off. Nothing is sent twice, and nothing half-added is left behind.</p></Notice>;
  if (kind === 'read-only') return <Notice title="The drive needs a check — adding files is paused" variant="warning"><p>Browsing and downloading still work. Run <a href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Check drive</a> in Settings → Storage and the upload picks up again.</p></Notice>;
  if (kind === 'away') return <Notice title="The drive is not connected — adding files is paused" variant="warning"><p>Plug it back in and the upload picks up where it left off.</p></Notice>;
  return null;
}

function FileRow({ entry, onFlow, onOpen, onToggle, readOnly, selected, selecting }: {
  entry: FileEntry;
  onFlow: (kind: 'delete' | 'download' | 'move' | 'rename') => void;
  onOpen: () => void;
  onToggle: () => void;
  readOnly: boolean;
  selected: boolean;
  selecting: boolean;
}) {
  const changeable = !entry.locked && !readOnly;
  const menu = [
    ...entry.kind === 'file' ? [{ label: 'Download', onSelect: () => onFlow('download') }] : [],
    ...changeable ? [{ label: 'Rename', onSelect: () => onFlow('rename') }, { label: 'Move', onSelect: () => onFlow('move') }, { label: 'Delete', onSelect: () => onFlow('delete') }] : [],
  ];
  return <PanelItem className={`suite-files-row${selecting ? ' is-selecting' : ''}`} selected={selected}>
    <span className="suite-files-pick">{changeable ? <SelectBox checked={selected} label={`Select ${entry.name}`} onChange={onToggle} /> : null}</span>
    <span className={`suite-files-icon is-${entry.kind}`}><Icon name={entry.kind} /></span>
    {entry.kind === 'folder'
      ? <a className="suite-files-name is-folder" href="#folder" onClick={(event) => { event.preventDefault(); onOpen(); }}>{entry.name}</a>
      : <span className="suite-files-name">{entry.name}</span>}
    <span className="suite-meta suite-files-facts">{entryFacts(entry)}</span>
    <span className="suite-files-actions">
      {entry.locked ? <Tooltip label={entry.locked}><Icon name="lock" /></Tooltip> : null}
      {menu.length ? <ActionMenu ariaLabel={`Actions for ${entry.name}`} items={menu} /> : null}
    </span>
  </PanelItem>;
}

function Leftovers({ driveId, leftovers, onFlow, writable }: { driveId: string; leftovers: Leftover[]; onFlow: (flow: Flow) => void; writable: boolean }) {
  const gone = [...new Set(leftovers.filter((item) => !item.installed).map((item) => item.appName))];
  const moved = [...new Set(leftovers.filter((item) => item.installed).map((item) => item.appName))];
  const from = (leftover: Leftover) => joinPath(['apps', leftover.app]);
  return <Panel>
    <PanelHead heading="h3" title="Also on this drive" />
    <PanelList>
      {leftovers.map((leftover) => <PanelItem className="suite-files-row is-leftover" key={leftover.path}>
        <span className="suite-files-icon is-leftover"><Icon name="folder" /></span>
        <span className="suite-files-leftover">
          <span className="suite-files-leftover-name">
            <a className="suite-files-name is-folder" href="#folder" onClick={(event) => { event.preventDefault(); openFiles(driveId, from(leftover)); }}>{leftover.app}</a>
            <span className="mos-pill">{leftover.installed ? 'uses another drive now' : 'no longer installed'}</span>
          </span>
          <span className="suite-meta">{leftover.name}{leftover.bytes !== null ? ` · ${formatBytes(leftover.bytes)}` : ''}</span>
        </span>
        <span className="suite-files-actions">
          <ActionMenu ariaLabel={`Actions for ${leftover.app}'s ${leftover.name}`} items={[
            { label: 'Browse', onSelect: () => openFiles(driveId, leftover.path) },
            ...writable ? [
              { label: 'Move', onSelect: () => onFlow({ entries: [leftoverEntry(leftover)], from: from(leftover), kind: 'move' }) },
              { label: 'Delete', onSelect: () => onFlow({ entries: [leftoverEntry(leftover)], from: from(leftover), kind: 'delete' }) },
            ] : [],
          ]} />
        </span>
      </PanelItem>)}
    </PanelList>
    <PanelBody>
      <p className="suite-meta">
        {gone.length ? `${joinNames(gone)} ${gone.length > 1 ? 'were' : 'was'} uninstalled; ${gone.length > 1 ? 'their' : 'its'} files stayed on the drive. ` : ''}
        {moved.length ? `${joinNames(moved)} now ${moved.length > 1 ? 'keep their' : 'keeps its'} files on another drive; these stayed here. ` : ''}
        Browse them, move them into another app&apos;s folder, or delete them to get the space back.
      </p>
    </PanelBody>
  </Panel>;
}

function NotOpen({ entry }: { entry: StorageEntry | null }) {
  return <Panel><PanelBody className="suite-files-empty">
    <Icon name="hard-drive" />
    <strong>{entry ? `${entry.name} is not open` : 'That drive is not connected'}</strong>
    <p className="suite-meta">{entry ? browseReason(entry) : 'Plug the drive in to browse its files.'} <a href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Settings → Storage</a></p>
  </PanelBody></Panel>;
}

// One drive's own files: browse, download, add, rename, move and delete, all on
// the drive itself. The page follows the drive live, so a pull, a check or a
// replug shows here without a reload.
export function FilesScreen() {
  const { driveId, path } = useLocation();
  const { error: storageError, storage } = useStorage();
  const entry = storage?.find((item) => item.id === driveId) || null;
  const browsable = Boolean(entry?.capabilities.browsable);
  const writable = Boolean(entry?.capabilities.writable);
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [dragging, setDragging] = useState(false);
  const [folderDropped, setFolderDropped] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const shown = useRef(path);

  const reload = useCallback(async () => {
    if (!driveId || !browsable) return;
    try {
      const listed = await listFiles(driveId, path);
      if (listed.path !== shown.current) return;
      setListing(listed);
      setError('');
      setSelected((current) => current.filter((name) => listed.entries.some((item) => item.name === name && !item.locked)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The files on this drive could not be listed.');
    }
  }, [browsable, driveId, path]);

  useEffect(() => {
    shown.current = path;
    setSelected([]);
    setListing((current) => (current?.path === path ? current : null));
  }, [path]);
  useEffect(() => { void reload(); }, [reload, entry?.state]);

  const segments = listing?.segments || (path ? path.split('/') : []);
  const folderName = segments.at(-1) || listing?.drive.name || entry?.name || 'this drive';
  const app = listing?.app?.readsDrive ? listing.app : null;
  const canAdd = writable && Boolean(listing) && !listing?.addRefusal;
  const uploads = useUploads({ driveId, onAdded: (folder) => { if (folder === shown.current) void reload(); }, writable });
  const entries = useMemo(() => listing?.entries || [], [listing]);
  const picked = entries.filter((item) => selected.includes(item.name));
  const selecting = picked.length > 0;
  const pickedBytes = sizeOf(picked);
  const toggle = (name: string) => setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  const done = () => { setFlow(null); setSelected([]); void reload(); };

  function addFiles(files: File[]) {
    if (files.length && canAdd) uploads.add(files, path, folderName);
  }

  // The whole page is the drop target while files are dragged over it.
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    const enter = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); depth += 1; setDragging(true); };
    const over = (event: DragEvent) => { if (carriesFiles(event)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!carriesFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (event: DragEvent) => { if (carriesFiles(event)) event.preventDefault(); depth = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  function dropped(event: ReactDragEvent) {
    event.preventDefault();
    setDragging(false);
    const items = [...event.dataTransfer.items];
    const folders = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
    setFolderDropped(folders);
    addFiles(items.filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)));
  }

  function act(kind: 'delete' | 'download' | 'move' | 'rename', target: FileEntry) {
    if (kind === 'download') download(driveId, joinPath(segments, target.name));
    else if (kind === 'rename') setFlow({ entry: target, from: path, kind });
    else setFlow({ entries: [target], from: path, kind });
  }

  const dropLabel = canAdd ? `Drop to add to ${folderName}` : 'Files cannot be added here';
  const dropNote = canAdd
    ? (app ? `${app.name} picks up new files on its own.` : 'They are added one at a time, and you can keep browsing.')
    : !writable ? 'This drive opened read-only until it is checked.' : listing?.addRefusal || '';

  return <section className="mos-shell mos-page suite-files">
    <a className="suite-files-back" href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>‹ Storage</a>
    <div className="suite-files-title">
      <h1>{listing?.drive.name || entry?.name || 'Drive'}</h1>
      {entry ? <span className={`suite-files-state is-${entry.state}`}><span aria-hidden="true" />{stateLabel(entry)}</span> : null}
    </div>
    <p className="suite-lead">These files live only on this drive — not in your backups.{app ? ` ${app.name} picks up changes on its own.` : ''}</p>

    {storage && !browsable ? <NotOpen entry={entry} /> : null}
    {storageError && !storage?.length ? <Notice title="Your storage could not be listed" variant="warning"><p>{storageError}</p></Notice> : null}

    {browsable ? <>
      {!writable ? <Notice title="This drive needs a check, so it opened read-only" variant="warning">
        <p>Browsing and downloading work. Adding, moving and deleting are paused until <a href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Check drive</a> in Settings → Storage puts it right — it takes seconds.</p>
      </Notice> : null}

      {folderDropped ? <Notice title="Folders cannot be dropped yet"><p>Open the folder on your computer and drop the files inside it, or make the folder here first with New folder.</p></Notice> : null}

      {selecting ? <div className="suite-files-toolbar is-selecting" role="toolbar" aria-label="Selection">
        <SelectBox checked label="Clear selection" onChange={() => setSelected([])} />
        <strong>{picked.length} selected{pickedBytes !== null ? ` · ${formatBytes(pickedBytes)}` : ''}</strong>
        {picked.length < entries.filter((item) => !item.locked).length ? <button className="mos-link suite-link-button" onClick={() => setSelected(entries.filter((item) => !item.locked).map((item) => item.name))} type="button">Select all {entries.filter((item) => !item.locked).length}</button> : null}
        <span className="suite-files-spacer" />
        <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => setFlow({ entries: picked, from: path, kind: 'move' })} type="button">Move</button>
        <button className="mos-btn mos-btn-danger mos-btn-sm" onClick={() => setFlow({ entries: picked, from: path, kind: 'delete' })} type="button">Delete</button>
        <button aria-label="Clear selection" className="suite-icon-button suite-files-quiet-button" onClick={() => setSelected([])} title="Clear selection" type="button"><Icon name="x" /></button>
      </div> : <div className="suite-files-toolbar">
        <Breadcrumbs driveId={driveId} driveName={listing?.drive.name || entry?.name || 'Drive'} segments={segments} />
        <span className="suite-files-spacer" />
        {!writable ? <span className="suite-meta">Download still works per file</span> : null}
        <button className="mos-btn mos-btn-secondary" disabled={!canAdd} onClick={() => setFlow({ kind: 'folder' })} title={listing?.addRefusal || undefined} type="button">New folder</button>
        <button className="mos-btn mos-btn-primary" disabled={!canAdd} onClick={() => picker.current?.click()} title={listing?.addRefusal || undefined} type="button"><Icon name="upload" />Add files</button>
        <input hidden multiple onChange={(event) => { addFiles([...event.currentTarget.files || []]); event.currentTarget.value = ''; }} ref={picker} type="file" />
      </div>}

      <InterruptionNotice kind={uploads.interruption} />
      {uploads.items.length ? <Panel>
        <PanelHead
          actions={uploads.busy ? <span className="suite-meta">Keep this page open while files are added.</span> : <button className="mos-btn mos-btn-ghost mos-btn-sm" onClick={uploads.clear} type="button">Clear</button>}
          heading="h3"
          title={uploads.busy ? `Adding ${filesLabel(uploads.items.filter((item) => item.status === 'sending' || item.status === 'waiting').length)} to ${uploads.items.find((item) => item.status === 'sending' || item.status === 'waiting')?.folderName || folderName}` : 'Done adding files'}
        />
        <PanelList>{uploads.items.map((item) => <UploadRow item={item} key={item.key} onStop={() => uploads.stop(item.key)} />)}</PanelList>
      </Panel> : null}

      {error ? <Notice title="This folder could not be opened" variant="warning"><p>{error} <a href="#top" onClick={(event) => { event.preventDefault(); openFiles(driveId); }}>Go to the top of the drive</a></p></Notice> : null}

      <Panel className="suite-files-list">
        {listing === null && !error ? <PanelBody><p className="suite-meta suite-storage-flow-working"><Spinner />Opening {folderName}…</p></PanelBody> : null}
        {listing && entries.length ? <PanelList>
          {entries.map((item) => <FileRow
            entry={item}
            key={item.name}
            onFlow={(kind) => act(kind, item)}
            onOpen={() => openFiles(driveId, joinPath(segments, item.name))}
            onToggle={() => toggle(item.name)}
            readOnly={!writable}
            selected={selected.includes(item.name)}
            selecting={selecting}
          />)}
        </PanelList> : null}
        {listing && !entries.length ? <PanelBody className="suite-files-empty">
          <Icon name="folder" />
          <strong>Nothing in {folderName} yet</strong>
          <p className="suite-meta">{canAdd ? 'Drop files here to add them — or plug the drive into any computer and copy a whole collection over at once.' : 'Plug the drive into any computer and copy a whole collection over at once.'} That is the fastest way{app ? `, and ${app.name} finds it all when the drive comes back` : ''}.</p>
        </PanelBody> : null}
        {listing && entries.length ? <PanelBody className="suite-files-footer">
          <span>{itemsLabel(listing.totals.items)}{listing.totals.bytes !== null ? ` · ${formatBytes(listing.totals.bytes)}` : ''} in {folderName}</span>
          {listing.drive.availableBytes !== null ? <span>{formatBytes(listing.drive.availableBytes)} free on this drive</span> : null}
        </PanelBody> : null}
      </Panel>

      {listing?.leftovers.length ? <Leftovers driveId={driveId} leftovers={listing.leftovers} onFlow={setFlow} writable={writable} /> : null}
    </> : null}

    {dragging && browsable ? createPortal(<div className="suite-files-drop" onDragOver={(event) => event.preventDefault()} onDrop={dropped}>
      <div className={`suite-files-drop-target${canAdd ? '' : ' is-refused'}`}>
        <Icon name={canAdd ? 'upload' : 'lock'} />
        <strong>{dropLabel}</strong>
        {dropNote ? <span>{dropNote}</span> : null}
      </div>
    </div>, document.body) : null}

    {flow?.kind === 'folder' ? <NameDialog
      action="Create"
      note="The folder is made on the drive right away, so it also shows up when the drive is plugged into another computer."
      onClose={() => setFlow(null)}
      onDone={done}
      onSubmit={(name) => createFolder(driveId, path, name)}
      title={`New folder in ${folderName}`}
    /> : null}
    {flow?.kind === 'rename' ? <NameDialog
      action="Save"
      initial={flow.entry.name}
      note="The new name is on the drive right away, so it also shows up when the drive is plugged into another computer."
      onClose={() => setFlow(null)}
      onDone={done}
      onSubmit={(name) => renameEntry(driveId, joinPath(flow.from ? flow.from.split('/') : [], flow.entry.name), name)}
      title={`Rename ${flow.entry.name}`}
    /> : null}
    {flow?.kind === 'move' ? <MoveDialog
      driveId={driveId}
      driveName={listing?.drive.name || entry?.name || 'this drive'}
      entries={flow.entries}
      from={flow.from}
      onClose={() => setFlow(null)}
      onDone={done}
      onMove={(to) => moveEntries(driveId, flow.entries.map((item) => joinPath(flow.from ? flow.from.split('/') : [], item.name)), to)}
    /> : null}
    {flow?.kind === 'delete' ? <DeleteDialog
      driveName={listing?.drive.name || entry?.name || 'this drive'}
      entries={flow.entries}
      onClose={() => setFlow(null)}
      onDelete={() => deleteEntries(driveId, flow.entries.map((item) => joinPath(flow.from ? flow.from.split('/') : [], item.name)))}
      onDone={done}
    /> : null}
  </section>;
}
