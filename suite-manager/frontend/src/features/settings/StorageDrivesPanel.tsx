import { useEffect, useState } from 'react';

import { AdvancedPanel, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Row, RowValue, Rows, Spinner } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import { canCheck, canEject, driveNeedsAttention, driveStateLabel, driveStateLine, keptDrives, useStorageDrives, type DriveAction } from '../apps/drives';
import type { StorageDrive } from '../apps/types';

type StorageFolder = { app: string; appName: string; bytes: number; driveId: string; installed: boolean; name: string };

function folderLabel(folder: StorageFolder) {
  return folder.installed ? `${folder.appName} · ${folder.name}` : `${folder.appName} · ${folder.name} (app uninstalled)`;
}

function appNames(drive: StorageDrive, folders: StorageFolder[]) {
  const names = [...new Set(folders.filter((folder) => folder.installed && drive.apps.includes(folder.app)).map((folder) => folder.appName))];
  return names.length ? names.join(' and ') : 'its apps';
}

// `startedHere` keeps the outcome of an action to the visit that asked for it, so
// the panel does not announce a check from last week every time it opens.
function DriveActions({ drive, folders, onAct, startedHere }: { drive: StorageDrive; folders: StorageFolder[]; onAct: (action: DriveAction) => void; startedHere: boolean }) {
  const job = drive.job;
  if (job?.status === 'running') {
    return <p className="suite-meta suite-drive-working"><Spinner />{job.steps[0]?.id === 'check' ? 'Checking the drive. Its apps are paused for a few seconds.' : 'Pausing its apps and closing the drive.'}</p>;
  }
  const check = canCheck(drive);
  const eject = canEject(drive);
  return <>
    {startedHere && job?.status === 'failed' ? <Notice title={job.steps[0]?.id === 'check' ? 'The drive was not repaired' : 'The drive was not ejected'} variant="warning"><p>{job.error?.message}</p></Notice> : null}
    {startedHere && job?.status === 'succeeded' && job.steps[0]?.id === 'check' && drive.state === 'ready' ? <Notice title="Checked" variant="success"><p>The drive works normally again.</p></Notice> : null}
    {check || eject ? <div className="suite-editor-actions">
      {check ? <button className="mos-btn mos-btn-primary" onClick={() => onAct('check')} type="button">Check drive</button> : null}
      {eject ? <button className="mos-btn mos-btn-secondary" onClick={() => onAct('eject')} type="button">Eject</button> : null}
    </div> : null}
    {check ? <p className="suite-meta">A quick repair that takes a few seconds while {appNames(drive, folders)} pause. If it cannot fix the drive, plug it into a Windows computer, open its Properties, choose Tools and then Check.</p> : null}
    {eject && !check ? <p className="suite-meta">Pauses {appNames(drive, folders)}, then tells you when it is safe to unplug. Plugging it back in starts them again.</p> : null}
  </>;
}

// The drives MOS keeps app files on, the state each is in, what is on each, and
// the one fact an owner most needs about them: they are not in the backup.
export function StorageDrivesPanel() {
  const { act, drives, error } = useStorageDrives();
  const [folders, setFolders] = useState<StorageFolder[]>([]);
  const [actionError, setActionError] = useState('');
  const [startedHere, setStartedHere] = useState<string[]>([]);

  // Folders are read once a drive is open, and again after it opens or closes.
  const mounted = (drives || []).filter((drive) => drive.state === 'ready' || drive.state === 'read-only').map((drive) => drive.id).join(' ');
  useEffect(() => {
    void fetch('/suite-manager/api/apps/storage/folders')
      .then((response) => jsonResponse<{ folders: StorageFolder[] }>(response, 'Unable to read the folders on your drives.'))
      .then((found) => setFolders(found.folders), () => setFolders([]));
  }, [mounted]);

  async function run(driveId: string, action: DriveAction) {
    setActionError('');
    setStartedHere((current) => [...current, driveId]);
    try { await act(driveId, action); } catch (caught) { setActionError(caught instanceof Error ? caught.message : 'MOS could not start that.'); }
  }

  const shown = drives ? keptDrives(drives, folders.map((folder) => folder.driveId)) : null;
  return <Panel>
    <PanelHead heading="h3" title="Storage drives">
      <p>Drives your apps keep their files on. You fill them from any computer; the apps read them where they are.</p>
    </PanelHead>
    {shown?.length ? <PanelList>
      {shown.map((drive) => {
        const onDrive = folders.filter((folder) => folder.driveId === drive.id);
        return <PanelItem key={drive.id} quiet={!drive.connected}>
          <div className="suite-drive-head">
            <strong>{drive.label}</strong>
            {drive.state !== 'ready' ? <span className={`mos-pill${driveNeedsAttention(drive) ? ' mos-pill-warning' : ''}`}>{driveStateLabel(drive)}</span> : null}
          </div>
          <p className="suite-meta">{driveStateLine(drive)}</p>
          {onDrive.length ? <Rows>
            {onDrive.map((folder) => <Row key={`${folder.app}/${folder.name}`} label={folderLabel(folder)}>
              <RowValue>{formatBytes(folder.bytes)}</RowValue>
            </Row>)}
          </Rows> : null}
          <DriveActions drive={drive} folders={onDrive} onAct={(action) => void run(drive.id, action)} startedHere={startedHere.includes(drive.id)} />
          <AdvancedPanel
            facts={[
              { label: 'Filesystem', value: drive.fileSystem || 'unknown' },
              { code: true, label: 'Drive id', value: drive.id },
            ]}
            output={drive.detail || undefined}
            reveal={driveNeedsAttention(drive) ? 'on-failure' : 'technical-mode'}
          />
        </PanelItem>;
      })}
    </PanelList> : null}
    {shown && !shown.length && !error ? <PanelBody>
      <p className="suite-meta">No app keeps files on a drive yet. Apps such as Jellyfin ask for one when you install them.</p>
    </PanelBody> : null}
    {error || actionError ? <PanelBody><Notice title={error ? 'Your drives could not be listed' : 'That did not start'} variant="warning"><p>{error || actionError}</p></Notice></PanelBody> : null}
    {shown?.length ? <PanelBand
      icon="backup"
      note="Keep another copy of anything on them you could not replace."
      title="Files on these drives are not part of your backups"
      tone="warning"
    /> : null}
  </Panel>;
}
