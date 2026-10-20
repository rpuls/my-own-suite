import { useState } from 'react';

import { ActionMenu, AdvancedPanel, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Spinner, Tooltip, type AdvancedFact } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { browseReason, openFiles } from '../files/model';
import { AddStorageDialog } from './AddStorageDialog';
import {
  freeLine,
  isAttention,
  rowLine,
  stateLabel,
  storageIcon,
  unusableFormat,
  useAppNames,
  useStorage,
  useStorageUsage,
  type BucketDraft,
  type InstallerStick,
  type StorageEntry,
  type StorageUsage,
} from './model';
import { EraseBackupsDialog } from '../backups/dialogs';
import { CheckDialog, DisconnectDialog, EjectDialog, FormatStickDialog, RenameDialog } from './StorageDialogs';
import { CloudUsage, UsageBar, usageSegments } from './UsageBar';

type Flow =
  | { kind: 'add' }
  | { kind: 'check' | 'disconnect' | 'eject' | 'rename'; id: string }
  | { archiveId: string; id: string; kind: 'erase' }
  | { kind: 'edit'; draft: BucketDraft }
  | { kind: 'format'; stick: InstallerStick };

function technicalFacts(entry: StorageEntry): AdvancedFact[] {
  if (entry.kind === 'bucket' && entry.bucket) {
    return [
      { label: 'Endpoint', value: entry.bucket.endpoint },
      { label: 'Bucket', value: entry.bucket.folder ? `${entry.bucket.bucket}/${entry.bucket.folder}` : entry.bucket.bucket },
      ...(entry.bucket.region ? [{ label: 'Region', value: entry.bucket.region }] : []),
      { code: true, label: 'Access key ID', value: entry.bucket.accessKeyId },
      { code: true, label: 'Storage id', value: entry.id },
    ];
  }
  if (entry.kind === 'system') return [{ label: 'Encrypted', value: entry.encrypted ? 'yes' : 'no' }];
  return [
    { label: 'Format', value: entry.fileSystem || 'unknown' },
    { code: true, label: 'Filesystem UUID', value: entry.id },
    ...(entry.devicePath ? [{ code: true, label: 'Device', value: entry.devicePath }] : []),
    { code: true, label: 'Opened at', value: entry.mountPath || 'not open' },
  ];
}

// Each app with its folders on the drive, then the backups, in one line.
function contentsLine(entry: StorageEntry, usage: StorageUsage | null) {
  const byApp = new Map<string, string[]>();
  for (const folder of usage?.folders.filter((item) => item.driveId === entry.id) || []) {
    const app = folder.installed ? folder.appName : `${folder.appName} (uninstalled)`;
    byApp.set(app, [...(byApp.get(app) || []), folder.name]);
  }
  const parts = [...byApp].map(([app, folders]) => `${app} — ${folders.join(', ')}`);
  if (entry.backups?.destination || usage?.backups.some((item) => item.driveId === entry.id)) parts.push('MOS backup archive');
  return parts.join(' · ');
}

function RowDetails({ entry, onRename, usage }: { entry: StorageEntry; onRename: () => void; usage: StorageUsage | null }) {
  const contents = entry.kind === 'drive' ? contentsLine(entry, usage) : '';
  const portable = entry.capabilities.holdsAppFolders ? 'opens on any computer' : 'opens only on Linux';
  return <div className="suite-storage-details">
    {entry.kind === 'bucket' ? <CloudUsage entry={entry} /> : <UsageBar entry={entry} segments={usageSegments(entry, usage)} variant="full" />}
    {entry.kind === 'system' ? <p className="suite-meta">Your apps keep their own data here, and that data is part of your MOS backups.{entry.encrypted ? ' Encrypted, so it cannot be read if the server is stolen.' : ''}</p> : null}
    {entry.kind === 'drive' && contents ? <p className="suite-meta">On this drive: <span className="suite-storage-contents">{contents}</span></p> : null}
    {entry.kind === 'drive' && !contents && entry.connected ? <p className="suite-meta">Nothing MOS keeps is on this drive yet. Pick it when you install an app that keeps files on a drive, or as a place for backups.</p> : null}
    {entry.kind === 'bucket' && !entry.backups?.destination ? <p className="suite-meta">Backups go here once you pick it in Backups, under Where backups go.</p> : null}
    {entry.kind === 'drive' ? <p className="suite-storage-note">
      {entry.apps.length ? 'App files here are not part of MOS backups · ' : ''}{portable}
      {entry.capabilities.renamable ? <> · <button className="mos-link suite-link-button" onClick={onRename} type="button">Rename</button></> : null}
    </p> : null}
    <AdvancedPanel facts={technicalFacts(entry)} output={entry.detail || undefined} reveal={isAttention(entry) ? 'on-failure' : 'technical-mode'} summary="Technical details" />
  </div>;
}

function StorageRow({ entry, expanded, names, onFlow, onToggle, onUse, usage }: {
  entry: StorageEntry;
  expanded: boolean;
  names: Map<string, string>;
  onFlow: (flow: Flow) => void;
  onToggle: () => void;
  onUse: () => void;
  usage: StorageUsage | null;
}) {
  const label = stateLabel(entry);
  const running = entry.job?.status === 'running';
  const menu = [
    ...entry.capabilities.renamable ? [{ label: 'Rename', onSelect: () => onFlow({ id: entry.id, kind: 'rename' }) }] : [],
    ...entry.kind === 'bucket' && entry.bucket ? [
      { label: 'Edit connection', onSelect: () => onFlow({ draft: { ...entry.bucket!, id: entry.id, label: entry.name, secretAccessKey: '' }, kind: 'edit' }) },
      { label: 'Disconnect', onSelect: () => onFlow({ id: entry.id, kind: 'disconnect' }) },
    ] : [],
    ...entry.kind === 'drive' && entry.connected ? (entry.backups?.otherServers || []).map((archive, _index, all) => ({
      label: all.length > 1 ? `Erase ${archive.writtenBy?.hostname || 'another server'}'s backups…` : 'Erase the other server\'s backups…',
      onSelect: () => onFlow({ archiveId: archive.id, id: entry.id, kind: 'erase' }),
    })) : [],
  ];
  return <PanelItem className={`suite-storage-row is-${entry.kind}${isAttention(entry) ? ' is-attention' : ''}`} flush quiet={!entry.connected || entry.state === 'ejected'} selected={expanded}>
    <div className="suite-storage-head">
      <span className="suite-storage-icon"><Icon name={storageIcon(entry)} /></span>
      <button aria-expanded={expanded} className="suite-storage-title" onClick={onToggle} type="button">
        <span className="suite-storage-name">
          <strong>{entry.name}</strong>
          {entry.kind === 'system' && entry.encrypted ? <span className="mos-pill"><Icon name="lock" />Encrypted</span> : null}
          {label && entry.kind !== 'system' ? <span className={`mos-pill${isAttention(entry) ? ' mos-pill-warning' : entry.state === 'ready' ? ' mos-pill-accent' : ''}`}>{label}</span> : null}
        </span>
        <span className="suite-meta">{rowLine(entry, names)}</span>
      </button>
      <div className="suite-storage-trailing">
        {running ? <span className="suite-meta suite-storage-flow-working"><Spinner />Working</span> : null}
        {!running && entry.capabilities.checkable ? <button className="mos-btn mos-btn-primary mos-btn-sm" onClick={() => onFlow({ id: entry.id, kind: 'check' })} type="button">Check drive</button> : null}
        {!running && entry.state === 'ejected' && entry.connected ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={onUse} type="button">Use it again</button> : null}
        {!running && expanded && entry.kind === 'drive' && entry.capabilities.holdsAppFolders ? (entry.capabilities.browsable
          ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => openFiles(entry.id)} type="button">Browse files</button>
          : <Tooltip label={browseReason(entry)}><button className="mos-btn mos-btn-secondary mos-btn-sm" disabled type="button">Browse files</button></Tooltip>) : null}
        {!running && expanded && entry.capabilities.ejectable ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => onFlow({ id: entry.id, kind: 'eject' })} type="button">Eject</button> : null}
        {expanded && menu.length ? <ActionMenu ariaLabel={`More actions for ${entry.name}`} items={menu} /> : null}
        {!expanded && (entry.kind === 'system' || entry.state === 'ready') ? <span className="suite-storage-glance">
          {entry.kind !== 'bucket' ? <UsageBar entry={entry} segments={[]} variant="compact" /> : null}
          <span className="suite-meta">{freeLine(entry)}</span>
        </span> : null}
        <button aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${entry.name}`} className="suite-icon-button suite-storage-chevron" onClick={onToggle} type="button"><Icon name="chevron-right" /></button>
      </div>
    </div>
    {expanded ? <RowDetails entry={entry} onRename={() => onFlow({ id: entry.id, kind: 'rename' })} usage={usage} /> : null}
  </PanelItem>;
}

// Every place this server can keep files, in one quiet list: rows collapsed until
// opened, actions only where they matter, technical facts behind the panel.
export function StoragePanel() {
  const { act, error, inventory, reload, storage } = useStorage();
  const names = useAppNames();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [formatted, setFormatted] = useState(false);
  const opened = (storage || []).filter((entry) => entry.mountPath || entry.kind === 'system').map((entry) => entry.id).join(' ');
  const usage = useStorageUsage(opened);
  const listed = (storage || []).filter((entry) => !unusableFormat(entry));
  const unusable = (storage || []).filter(unusableFormat);
  const flowEntry = flow && 'id' in flow ? storage?.find((entry) => entry.id === flow.id) : undefined;
  const appNames = (entry: StorageEntry) => entry.apps.map((app) => names.get(app) || app);
  const close = () => { setFlow(null); void reload(); };

  return <>
    <Panel>
      <PanelHead
        actions={<button className="mos-btn mos-btn-primary mos-btn-sm" onClick={() => setFlow({ kind: 'add' })} type="button"><Icon name="plus" />Add storage</button>}
        heading="h3"
        title="Storage"
      >
        <p>Every place this server can keep files. Apps and backups pick from this one list.</p>
      </PanelHead>
      {(inventory?.installerSticks || []).map((stick) => <PanelBand
        icon="usb-stick"
        key={stick.devicePath}
        layout="row"
        note="A power cut could restart the server into the installer. Take it out, or format it for storage."
        title="The MOS install stick is still plugged in."
        tone="warning"
      >
        <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => setFlow({ kind: 'format', stick })} type="button">Format for storage</button>
      </PanelBand>)}
      {formatted ? <PanelBody><Notice title="The stick is a storage drive now" variant="success"><p>It is listed below as MOS STORAGE. Rename it, or pick it for an app or for backups.</p></Notice></PanelBody> : null}
      {storage === null && !error ? <PanelBody><p className="suite-meta suite-storage-flow-working"><Spinner />Looking at what is plugged in…</p></PanelBody> : null}
      {listed.length ? <PanelList>
        {listed.map((entry) => <StorageRow
          entry={entry}
          expanded={expanded.includes(entry.id)}
          key={entry.id}
          names={names}
          onFlow={setFlow}
          onToggle={() => setExpanded((current) => (current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id]))}
          onUse={() => void act(entry.id, 'use').catch(() => reload())}
          usage={usage}
        />)}
      </PanelList> : null}
      {unusable.map((entry) => <PanelBody className="suite-storage-unusable" key={entry.id}>
        <p className="suite-meta"><Icon name="hard-drive" />{[entry.model || entry.label, entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : ''].filter(Boolean).join(' · ')} — this drive&apos;s format can&apos;t hold app files or backups.</p>
        <AdvancedPanel facts={technicalFacts(entry)} reveal="technical-mode" summary="Technical details" />
      </PanelBody>)}
      {error ? <PanelBody><Notice title="Your storage could not be listed" variant="warning"><p>{error}</p></Notice></PanelBody> : null}
    </Panel>

    {flow?.kind === 'add' ? <AddStorageDialog onClose={close} onConnected={close} /> : null}
    {flow?.kind === 'edit' ? <AddStorageDialog editing={flow.draft} onClose={close} onConnected={close} /> : null}
    {flow?.kind === 'format' ? <FormatStickDialog onClose={close} onFormatted={() => { setFormatted(true); close(); }} stick={flow.stick} /> : null}
    {flowEntry && flow?.kind === 'eject' ? <EjectDialog act={act} appNames={appNames(flowEntry)} entry={flowEntry} onClose={close} /> : null}
    {flowEntry && flow?.kind === 'check' ? <CheckDialog act={act} appNames={appNames(flowEntry)} entry={flowEntry} onClose={close} /> : null}
    {flowEntry && flow?.kind === 'rename' ? <RenameDialog entry={flowEntry} onClose={close} onRenamed={close} /> : null}
    {flowEntry && flow?.kind === 'disconnect' ? <DisconnectDialog entry={flowEntry} onClose={close} onDisconnected={close} /> : null}
    {flowEntry && flow?.kind === 'erase' ? <EraseBackupsDialog
      archive={{ from: flowEntry.backups?.otherServers.find((archive) => archive.id === flow.archiveId)?.writtenBy?.hostname || null, id: flow.archiveId, label: flowEntry.name, newestAt: null, restorePoints: null }}
      onClose={close}
      onErased={close}
    /> : null}
  </>;
}
