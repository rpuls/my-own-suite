import { useEffect, useState } from 'react';

import { Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Row, RowValue, Rows } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { StorageDrive } from '../apps/types';

type StorageFolder = { app: string; appName: string; bytes: number; driveId: string; installed: boolean; name: string };

function driveLine(drive: StorageDrive) {
  if (!drive.connected) return 'Not connected. Plug it back in and its apps get their files back.';
  const space = drive.availableBytes !== null && drive.sizeBytes !== null
    ? `${formatBytes(drive.availableBytes)} free of ${formatBytes(drive.sizeBytes)}`
    : drive.sizeBytes !== null ? formatBytes(drive.sizeBytes) : '';
  return [space, drive.holdsBackups ? 'also holds your backups' : ''].filter(Boolean).join(' · ');
}

function folderLabel(folder: StorageFolder) {
  return folder.installed ? `${folder.appName} · ${folder.name}` : `${folder.appName} · ${folder.name} (app uninstalled)`;
}

// The drives MOS keeps app files on, what is on each, and the one fact an owner
// most needs about them: they are not in the backup.
export function StorageDrivesPanel() {
  const [drives, setDrives] = useState<StorageDrive[] | null>(null);
  const [folders, setFolders] = useState<StorageFolder[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [listed, found] = await Promise.all([
          fetch('/suite-manager/api/apps/storage/drives').then((response) => jsonResponse<{ drives: StorageDrive[] }>(response, 'Unable to list your drives.')),
          fetch('/suite-manager/api/apps/storage/folders').then((response) => jsonResponse<{ folders: StorageFolder[] }>(response, 'Unable to read the folders on your drives.')),
        ]);
        setFolders(found.folders);
        setDrives(listed.drives.filter((drive) => drive.apps.length || found.folders.some((folder) => folder.driveId === drive.id)));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to list your drives.');
        setDrives([]);
      }
    })();
  }, []);

  return <Panel>
    <PanelHead heading="h3" title="Storage drives">
      <p>Drives your apps keep their files on. You fill them from any computer; the apps read them where they are.</p>
    </PanelHead>
    {drives?.length ? <PanelList>
      {drives.map((drive) => {
        const onDrive = folders.filter((folder) => folder.driveId === drive.id);
        return <PanelItem key={drive.id} quiet={!drive.connected}>
          <strong>{drive.label}</strong>
          <p className="suite-meta">{driveLine(drive)}</p>
          {onDrive.length ? <Rows>
            {onDrive.map((folder) => <Row key={`${folder.app}/${folder.name}`} label={folderLabel(folder)}>
              <RowValue>{formatBytes(folder.bytes)}</RowValue>
            </Row>)}
          </Rows> : null}
        </PanelItem>;
      })}
    </PanelList> : null}
    {drives && !drives.length && !error ? <PanelBody>
      <p className="suite-meta">No app keeps files on a drive yet. Apps such as Jellyfin ask for one when you install them.</p>
    </PanelBody> : null}
    {error ? <PanelBody><Notice title="Your drives could not be listed" variant="warning"><p>{error}</p></Notice></PanelBody> : null}
    {drives?.length ? <PanelBand
      icon="backup"
      note="Keep another copy of anything on them you could not replace."
      title="Files on these drives are not part of your backups"
      tone="warning"
    /> : null}
  </Panel>;
}
