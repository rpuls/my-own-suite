import { useState } from 'react';

import { ActionMenu, AdvancedPanel, DisclosureRow, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Spinner, Tooltip, type AdvancedFact } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { whenWords } from '../../lib/dates';
import { filesPath, navigateTo } from '../../lib/navigation';
import { EraseBackupsDialog } from '../archives/EraseBackupsDialog';
import { AddStorageDialog } from './AddStorageDialog';
import {
  BACKUPS_UNKNOWN_LINE,
  appNamesFor,
  browseReason,
  freeLine,
  isAttention,
  rowLine,
  stateLabel,
  statePill,
  storageIcon,
  unusableFormat,
  useStorage,
  useStorageUsage,
  type AppNames,
  type BucketDraft,
  type InstallerStick,
  type OtherServerArchive,
  type StorageEntry,
  type StorageUsage,
} from './model';
import { CheckDialog, DisconnectDialog, EjectDialog, FormatStickDialog, RenameDialog, UseAgainDialog } from './StorageDialogs';
import { CloudUsage, UsageBar, usageSegments } from './UsageBar';

type Flow =
  | { kind: 'add' }
  | { kind: 'check' | 'disconnect' | 'eject' | 'rename' | 'use'; id: string }
  | { archiveId: string; id: string; kind: 'erase' }
  | { kind: 'edit'; draft: BucketDraft }
  | { kind: 'format'; stick: InstallerStick };

type Facts = { backupsKnown: boolean; names: AppNames };

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
function contentsLine(entry: StorageEntry, usage: StorageUsage | null, backupsKnown: boolean) {
  const byApp = new Map<string, string[]>();
  for (const folder of usage?.folders.filter((item) => item.driveId === entry.id) || []) {
    const app = folder.installed ? folder.appName : `${folder.appName} (uninstalled)`;
    byApp.set(app, [...(byApp.get(app) || []), folder.name]);
  }
  const parts = [...byApp].map(([app, folders]) => `${app} — ${folders.join(', ')}`);
  if ((backupsKnown && entry.backups?.ours) || usage?.backups.some((item) => item.driveId === entry.id)) parts.push('MOS backup archive');
  return parts.join(' · ');
}

// Two archives without a hostname still have to be told apart in a menu.
function eraseLabel(archive: OtherServerArchive, count: number) {
  if (count === 1) return 'Erase the other server\'s backups…';
  if (archive.writtenBy?.hostname) return `Erase ${archive.writtenBy.hostname}'s backups…`;
  return `Erase another server's backups (${archive.newestAt ? `newest ${whenWords(archive.newestAt).toLowerCase()}` : archive.id.slice(-8)})…`;
}

function stickLine(stick: InstallerStick) {
  return [stick.model, stick.sizeBytes !== null ? formatBytes(stick.sizeBytes) : ''].filter(Boolean).join(' · ');
}

function RowDetails({ backupsKnown, entry, onRename, usage }: { backupsKnown: boolean; entry: StorageEntry; onRename: () => void; usage: StorageUsage | null }) {
  const contents = entry.kind === 'drive' ? contentsLine(entry, usage, backupsKnown) : '';
  const portable = entry.capabilities.holdsAppFolders ? 'opens on any computer' : 'opens only on Linux';
  return <div className="suite-storage-details">
    {entry.kind === 'bucket' ? <CloudUsage entry={entry} /> : <UsageBar entry={entry} segments={usageSegments(entry, usage)} variant="full" />}
    {entry.kind === 'system' ? <p className="suite-meta">Your apps keep their own data here, and that data is part of your MOS backups.{entry.encrypted ? ' Encrypted, so it cannot be read if the server is stolen.' : ''}</p> : null}
    {entry.kind === 'drive' && contents ? <p className="suite-meta">On this drive: <span className="suite-storage-contents">{contents}</span></p> : null}
    {entry.kind === 'drive' && !contents && entry.connected && backupsKnown ? <p className="suite-meta">Nothing MOS keeps is on this drive yet. Pick it when you install an app that keeps files on a drive, or as a place for backups.</p> : null}
    {entry.kind !== 'system' && !backupsKnown ? <p className="suite-storage-warning">{BACKUPS_UNKNOWN_LINE}</p> : null}
    {entry.kind === 'bucket' && backupsKnown && !entry.backups?.ours ? <p className="suite-meta">This server&apos;s backups go here once you back up to it from Backup &amp; Restore.</p> : null}
    {entry.kind === 'drive' ? <p className="suite-storage-note">
      {entry.apps.length ? 'App files here are not part of MOS backups · ' : ''}{portable}
      {entry.capabilities.renamable ? <> · <button className="mos-link suite-link-button" onClick={onRename} type="button">Rename</button></> : null}
    </p> : null}
    <AdvancedPanel facts={technicalFacts(entry)} output={entry.detail || undefined} reveal={isAttention(entry) ? 'on-failure' : 'technical-mode'} summary="Technical details" />
  </div>;
}

function StorageRow({ entry, expanded, facts, onFlow, onToggle, usage }: {
  entry: StorageEntry;
  expanded: boolean;
  facts: Facts;
  onFlow: (flow: Flow) => void;
  onToggle: () => void;
  usage: StorageUsage | null;
}) {
  const label = stateLabel(entry);
  const running = entry.job?.status === 'running';
  const bucket = entry.bucket;
  const others = facts.backupsKnown && entry.kind === 'drive' && entry.connected ? entry.backups?.otherServers || [] : [];
  const menu = [
    ...entry.capabilities.renamable ? [{ label: 'Rename', onSelect: () => onFlow({ id: entry.id, kind: 'rename' }) }] : [],
    ...entry.kind === 'bucket' && bucket ? [
      { label: 'Edit connection', onSelect: () => onFlow({ draft: { ...bucket, id: entry.id, label: entry.name, secretAccessKey: '' }, kind: 'edit' }) },
      { label: 'Disconnect', onSelect: () => onFlow({ id: entry.id, kind: 'disconnect' }) },
    ] : [],
    ...others.map((archive) => ({ label: eraseLabel(archive, others.length), onSelect: () => onFlow({ archiveId: archive.id, id: entry.id, kind: 'erase' }) })),
  ];
  const trailing = <>
    {running ? <span className="suite-meta suite-storage-flow-working"><Spinner />Working</span> : null}
    {!running && entry.capabilities.checkable ? <button className="mos-btn mos-btn-primary mos-btn-sm" onClick={() => onFlow({ id: entry.id, kind: 'check' })} type="button">Check drive</button> : null}
    {!running && entry.state === 'ejected' && entry.connected ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => onFlow({ id: entry.id, kind: 'use' })} type="button">Use it again</button> : null}
    {!running && expanded && entry.kind === 'drive' && entry.capabilities.holdsAppFolders ? (entry.capabilities.browsable
      ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => navigateTo(filesPath(entry.id))} type="button">Browse files</button>
      : <Tooltip label={browseReason(entry)}><button className="mos-btn mos-btn-secondary mos-btn-sm" disabled type="button">Browse files</button></Tooltip>) : null}
    {!running && expanded && entry.capabilities.ejectable ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => onFlow({ id: entry.id, kind: 'eject' })} type="button">Eject</button> : null}
    {expanded && menu.length ? <ActionMenu ariaLabel={`More actions for ${entry.name}`} items={menu} /> : null}
    {!expanded && (entry.kind === 'system' || entry.state === 'ready') ? <span className="suite-storage-glance">
      {entry.kind !== 'bucket' ? <UsageBar entry={entry} segments={[]} variant="compact" /> : null}
      <span className="suite-meta">{freeLine(entry)}</span>
    </span> : null}
  </>;
  return <PanelItem className={`suite-storage-row is-${entry.kind}${isAttention(entry) ? ' is-attention' : ''}`} flush quiet={!entry.connected || entry.state === 'ejected'} selected={expanded}>
    <DisclosureRow expanded={expanded} icon={storageIcon(entry)} label={`${expanded ? 'Hide' : 'Show'} details for ${entry.name}`} onToggle={onToggle} trailing={trailing}>
      <span className="suite-storage-name">
        <strong>{entry.name}</strong>
        {entry.kind === 'system' && entry.encrypted ? <span className="mos-pill"><Icon name="lock" />Encrypted</span> : null}
        {label && entry.kind !== 'system' ? <span className={statePill(entry)}>{label}</span> : null}
      </span>
      <span className="suite-meta">{rowLine(entry, facts)}</span>
    </DisclosureRow>
    {expanded ? <RowDetails backupsKnown={facts.backupsKnown} entry={entry} onRename={() => onFlow({ id: entry.id, kind: 'rename' })} usage={usage} /> : null}
  </PanelItem>;
}

// Every place this server can keep files, in one quiet list: rows collapsed until
// opened, actions only where they matter, technical facts behind the panel.
export function StoragePanel() {
  const { act, error, inventory, names, reload, storage } = useStorage();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [formatted, setFormatted] = useState(false);
  const facts: Facts = { backupsKnown: inventory?.backupsKnown === true, names };
  const opened = (storage || []).filter((entry) => entry.mountPath || entry.kind === 'system').map((entry) => entry.id).join(' ');
  const usage = useStorageUsage(opened);
  const listed = (storage || []).filter((entry) => !unusableFormat(entry));
  const unusable = (storage || []).filter(unusableFormat);
  const flowEntry = flow && 'id' in flow ? storage?.find((entry) => entry.id === flow.id) : undefined;
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
        busy={stick.job?.status === 'running'}
        icon="usb-stick"
        key={stick.devicePath}
        layout="row"
        note="A power cut could restart the server into the installer. Take it out, or format it for storage."
        title={`The MOS install stick is still plugged in${stickLine(stick) ? ` — ${stickLine(stick)}` : ''}.`}
        tone="warning"
      >
        {stick.job?.status === 'running'
          ? <span className="suite-meta">Formatting…</span>
          : <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => setFlow({ kind: 'format', stick })} type="button">Format for storage</button>}
      </PanelBand>)}
      {formatted ? <PanelBody><Notice title="The stick is a storage drive now" variant="success"><p>It is listed below as {inventory?.formattedLabel || 'an ordinary drive'}. Rename it, or pick it for an app or for backups.</p></Notice></PanelBody> : null}
      {storage === null && !error ? <PanelBody><p className="suite-meta suite-storage-flow-working"><Spinner />Looking at what is plugged in…</p></PanelBody> : null}
      {listed.length ? <PanelList>
        {listed.map((entry) => <StorageRow
          entry={entry}
          expanded={expanded.includes(entry.id)}
          facts={facts}
          key={entry.id}
          onFlow={setFlow}
          onToggle={() => setExpanded((current) => (current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id]))}
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
    {flowEntry && flow?.kind === 'eject' ? <EjectDialog act={act} appNames={appNamesFor(flowEntry, names)} entry={flowEntry} onClose={close} /> : null}
    {flowEntry && flow?.kind === 'use' ? <UseAgainDialog act={act} appNames={appNamesFor(flowEntry, names)} entry={flowEntry} onClose={close} /> : null}
    {flowEntry && flow?.kind === 'check' ? <CheckDialog act={act} appNames={appNamesFor(flowEntry, names)} entry={flowEntry} onClose={close} /> : null}
    {flowEntry && flow?.kind === 'rename' ? <RenameDialog entry={flowEntry} onClose={close} onRenamed={close} /> : null}
    {flowEntry && flow?.kind === 'disconnect' ? <DisconnectDialog entry={flowEntry} onClose={close} onDisconnected={close} /> : null}
    {flowEntry && flow?.kind === 'erase' ? <EraseBackupsDialog
      archive={eraseTarget(flowEntry, flow.archiveId)}
      onClose={close}
      onErased={close}
    /> : null}
  </>;
}

function eraseTarget(entry: StorageEntry, archiveId: string) {
  const archive = entry.backups?.otherServers.find((item) => item.id === archiveId);
  return { from: archive?.writtenBy?.hostname || null, id: archiveId, label: entry.name, newestAt: archive?.newestAt || null, restorePoints: archive?.restorePoints ?? null };
}
