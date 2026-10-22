import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';

import { ActionMenu, Dialog, Icon, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, ProgressBar, SelectBox, Spinner, Tooltip } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { BACKUPS_PATH, navigateTo, openBackups, openStorageSettings, STORAGE_SETTINGS_PATH } from '../../lib/navigation';
import { browseReason, stateLabel, statePill, type StorageEntry } from '../storage/model';
import { DeleteDialog, MoveDialog, NameDialog } from './FilesDialogs';
import { FilesToolbar } from './FilesToolbar';
import {
  appStateLabel,
  canSelect,
  createFolder,
  deleteEntries,
  downloadHref,
  entryFacts,
  filesLabel,
  itemsLabel,
  joinPath,
  moveEntries,
  openFiles,
  renameEntry,
  type FileEntry,
  type FilesListing,
} from './model';
import { useFilesListing } from './useFilesListing';
import { useUploads, type Interruption, type UploadItem } from './uploads';

type Flow =
  | { kind: 'folder' | 'leave' }
  | { entry: FileEntry; from: string; kind: 'rename' }
  | { entries: FileEntry[]; from: string; kind: 'delete' | 'move'; then?: () => void };

function download(driveId: string, path: string) {
  const link = document.createElement('a');
  link.href = downloadHref(driveId, path);
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
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

// What MOS uses now is drawn in color; what an app left and what MOS never made
// are grey, and only the first of those can be changed.
function FileRow({ dimmed, entry, onFlow, onOpen, onToggle, readOnly, selected, selecting }: {
  dimmed: boolean;
  entry: FileEntry;
  onFlow: (kind: 'delete' | 'download' | 'move' | 'rename') => void;
  onOpen: () => void;
  onToggle: () => void;
  readOnly: boolean;
  selected: boolean;
  selecting: boolean;
}) {
  const changeable = !entry.refusals.change && !readOnly;
  const deletable = !entry.refusals.delete && !readOnly;
  const leftover = Boolean(entry.appState);
  const menu = [
    ...entry.kind === 'file' ? [{ label: 'Download', onSelect: () => onFlow('download') }] : [],
    ...changeable ? [{ label: 'Rename', onSelect: () => onFlow('rename') }, { label: 'Move', onSelect: () => onFlow('move') }, { label: 'Delete', onSelect: () => onFlow('delete') }] : [],
    ...leftover ? [{ label: 'Open', onSelect: onOpen }] : [],
    ...deletable && !changeable ? [{ label: `Delete ${entry.appName || entry.name}'s files`, onSelect: () => onFlow('delete') }] : [],
  ];
  const quiet = dimmed || !entry.managed || leftover;
  return <PanelItem className={`suite-files-row${selecting ? ' is-selecting' : ''}${quiet ? ' is-unused' : ''}`} selected={selected}>
    <span className="suite-files-pick">{canSelect(entry, readOnly) ? <SelectBox checked={selected} label={`Select ${entry.name}`} onChange={onToggle} /> : null}</span>
    <span className={`suite-files-icon is-${entry.kind}`}><Icon name={entry.kind} /></span>
    <span className="suite-files-label">
      {entry.kind === 'folder' && !entry.special
        ? <a className="suite-files-name is-folder" href="#folder" onClick={(event) => { event.preventDefault(); onOpen(); }}>{entry.name}</a>
        : <span className="suite-files-name">{entry.name}</span>}
      {entry.appState ? <span className="mos-pill">{appStateLabel(entry.appState)}</span> : null}
    </span>
    {entry.special === 'backups'
      ? <a className="suite-files-facts" href={BACKUPS_PATH} onClick={openBackups}>Your backups — open in Backups ›</a>
      : <span className="suite-meta suite-files-facts">{entryFacts(entry)}</span>}
    <span className="suite-files-actions">
      {entry.refusals.delete && entry.managed && !entry.special ? <Tooltip label={entry.refusals.delete}><Icon name="lock" /></Tooltip> : null}
      {menu.length ? <ActionMenu ariaLabel={`Actions for ${entry.name}`} items={menu} /> : null}
    </span>
  </PanelItem>;
}

function LeftoverNotice({ app, onDelete, readOnly }: { app: NonNullable<FilesListing['app']>; onDelete: () => void; readOnly: boolean }) {
  return <Notice title={app.state === 'elsewhere' ? `${app.name} keeps its files on another drive now` : `${app.name} is not installed`}>
    <p>Its files stayed on this drive. Move what you want to keep into another folder{readOnly ? '.' : <>, or <button className="mos-link suite-link-button" onClick={onDelete} type="button">delete {app.name}&apos;s files</button>.</>}</p>
  </Notice>;
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
  const { browsable, driveId, driveName, entry, error, folderName, listing, path, reload, segments, shown, storage, storageError, writable } = useFilesListing();
  const [selected, setSelected] = useState<string[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [dragging, setDragging] = useState(false);
  const [folderDropped, setFolderDropped] = useState(false);

  useEffect(() => { setSelected([]); }, [path]);
  useEffect(() => {
    setSelected((current) => current.filter((name) => listing?.entries.some((item) => item.name === name && !item.refusals.delete)));
  }, [listing]);

  const app = listing?.app?.readsDrive ? listing.app : null;
  const leftApp = listing?.app?.state ? listing.app : null;
  const canAdd = writable && Boolean(listing) && !listing?.addRefusal;
  const uploads = useUploads({ onAdded: (folder) => { if (folder === shown.current) void reload(); }, writable });
  const entries = useMemo(() => listing?.entries || [], [listing]);
  const picked = entries.filter((item) => selected.includes(item.name));
  const selecting = picked.length > 0;
  const toggle = (name: string) => setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  const done = () => {
    const then = flow && 'then' in flow ? flow.then : undefined;
    setFlow(null);
    setSelected([]);
    if (then) then();
    else void reload();
  };
  const parentPath = joinPath(segments.slice(0, -1));
  const deleteLeftApp = () => {
    if (!listing?.app) return;
    const folder: FileEntry = { appName: listing.app.name, appState: listing.app.state, bytes: listing.totals.bytes, items: listing.totals.items, kind: 'folder', managed: true, modifiedAt: '', name: listing.app.id, refusals: { change: null, delete: null }, special: null };
    setFlow({ entries: [folder], from: parentPath, kind: 'delete', then: () => openFiles(driveId, parentPath, { replace: true }) });
  };

  function addFiles(files: File[]) {
    if (files.length && canAdd) uploads.add(files, { driveId, folder: path, folderName });
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

  // Leaving stops the files still on their way; asked first, like a tab close.
  function leave(event: { preventDefault: () => void }) {
    if (!uploads.busy) {
      openStorageSettings(event);
      return;
    }
    event.preventDefault();
    setFlow({ kind: 'leave' });
  }

  const dropLabel = canAdd ? `Drop to add to ${folderName}` : 'Files cannot be added here';
  const dropNote = canAdd
    ? (app ? `${app.name} picks up new files on its own.` : 'They are added one at a time, and you can keep browsing.')
    : !writable ? 'This drive opened read-only until it is checked.' : listing?.addRefusal || '';

  return <section className="mos-shell mos-page suite-files">
    <a className="suite-files-back" href={STORAGE_SETTINGS_PATH} onClick={leave}>‹ Storage</a>
    <div className="suite-files-title">
      <h1>{driveName}</h1>
      {entry ? <span className={statePill(entry)}>{stateLabel(entry)}</span> : null}
    </div>
    <p className="suite-lead">These files live only on this drive — not in your backups.{app ? ` ${app.name} picks up changes on its own.` : ''}</p>

    {storage && !browsable ? <NotOpen entry={entry} /> : null}
    {storageError && !storage?.length ? <Notice title="Your storage could not be listed" variant="warning"><p>{storageError}</p></Notice> : null}

    {browsable ? <>
      {!writable ? <Notice title="This drive needs a check, so it opened read-only" variant="warning">
        <p>Browsing and downloading work. Adding, moving and deleting are paused until <a href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Check drive</a> in Settings → Storage puts it right — it takes seconds.</p>
      </Notice> : null}

      {folderDropped ? <Notice title="Folders cannot be dropped yet"><p>Open the folder on your computer and drop the files inside it, or make the folder here first with New folder.</p></Notice> : null}

      <FilesToolbar
        canAdd={canAdd}
        driveId={driveId}
        driveName={driveName}
        entries={entries}
        listing={listing}
        onAddFiles={addFiles}
        onDelete={() => setFlow({ entries: picked, from: path, kind: 'delete' })}
        onMove={() => setFlow({ entries: picked, from: path, kind: 'move' })}
        onNewFolder={() => setFlow({ kind: 'folder' })}
        onSelect={setSelected}
        picked={picked}
        segments={segments}
        writable={writable}
      />

      {listing && !listing.managed && segments.length ? <Notice title="MOS does not manage these files">
        <p>You can look inside and download them. To change them, plug the drive into the computer they came from — or move them into MOS-files there, and they can be managed here.</p>
      </Notice> : null}
      {leftApp ? <LeftoverNotice app={leftApp} onDelete={deleteLeftApp} readOnly={!writable} /> : null}

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
            dimmed={Boolean(leftApp)}
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

    </> : null}

    {dragging && browsable ? createPortal(<div className="suite-files-drop" onDragOver={(event) => event.preventDefault()} onDrop={dropped}>
      <div className={`suite-files-drop-target${canAdd ? '' : ' is-refused'}`}>
        <Icon name={canAdd ? 'upload' : 'lock'} />
        <strong>{dropLabel}</strong>
        {dropNote ? <span>{dropNote}</span> : null}
      </div>
    </div>, document.body) : null}

    {flow?.kind === 'leave' ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-secondary" onClick={() => setFlow(null)} type="button">Keep adding</button>
        <button className="mos-btn mos-btn-danger" onClick={() => navigateTo(STORAGE_SETTINGS_PATH)} type="button">Leave and stop</button>
      </>}
      onClose={() => setFlow(null)}
      title="Files are still being added"
    >
      <p>Leaving this page stops them. Drop the same files again later and MOS carries on from where the drive has them.</p>
    </Dialog> : null}
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
