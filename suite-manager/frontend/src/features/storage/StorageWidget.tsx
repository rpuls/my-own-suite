import { useState } from 'react';

import { Icon, Panel, PanelHead, PanelItem, PanelList } from '../../components/ui';
import { whenWords } from '../backups/model';
import { freeLine, isAttention, stateLabel, storageIcon, useAppNames, useStorage, type StorageEntry } from './model';
import { CheckDialog } from './StorageDialogs';
import { UsageBar } from './UsageBar';

// Storage MOS keeps something on, plus anything that needs the owner.
function kept(entry: StorageEntry) {
  return entry.kind !== 'system' && (entry.apps.length > 0 || entry.backups?.destination === true || isAttention(entry));
}

function glanceLine(entry: StorageEntry) {
  if (entry.state !== 'ready' && entry.state !== 'available') return stateLabel(entry);
  if (entry.kind === 'bucket') return entry.backups?.lastBackupAt ? `Cloud · backed up ${whenWords(entry.backups.lastBackupAt).toLowerCase()}` : 'Cloud · no backups yet';
  return freeLine(entry);
}

// So a drive that came back read-only or is unplugged is seen without looking for it.
export function StorageWidget({ onManage }: { onManage: () => void }) {
  const { act, reload, storage } = useStorage();
  const names = useAppNames();
  const [checking, setChecking] = useState('');
  const shown = (storage || []).filter(kept);
  const checked = storage?.find((entry) => entry.id === checking);
  if (!shown.length) return null;
  return <Panel>
    <PanelHead actions={<button className="mos-btn mos-btn-ghost" onClick={onManage} type="button">Manage<Icon name="arrow-right" /></button>} heading="h2" title="Storage" />
    <PanelList>
      {shown.map((entry) => <PanelItem className="suite-storage-widget-row" key={entry.id} quiet={!entry.connected || entry.state === 'ejected'}>
        <span className="suite-storage-icon"><Icon name={storageIcon(entry)} /></span>
        <div className="suite-storage-widget-body">
          <strong>{entry.name}</strong>
          {entry.kind === 'drive' ? <UsageBar entry={entry} segments={[]} variant="compact" /> : null}
          <span className={isAttention(entry) ? 'suite-storage-warning' : 'suite-meta'}>{glanceLine(entry)}</span>
        </div>
        {entry.capabilities.checkable ? <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => setChecking(entry.id)} type="button">Check</button> : null}
      </PanelItem>)}
    </PanelList>
    {checked ? <CheckDialog act={act} appNames={checked.apps.map((app) => names.get(app) || app)} entry={checked} onClose={() => { setChecking(''); void reload(); }} /> : null}
  </Panel>;
}
