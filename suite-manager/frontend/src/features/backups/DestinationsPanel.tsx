import { ActionMenu, Icon, Panel, PanelBand, PanelHead, PanelItem, PanelList, Radio, Spinner } from '../../components/ui';
import { openStorageSettings, STORAGE_SETTINGS_PATH } from '../../lib/navigation';
import { destinationIconName, placeOf, type DestinationView, type OtherArchiveView } from './model';

// The places this server backs up to, one row each, the selected one first. A row
// has three zones: the radio that chooses it, what it is and how it is doing, and
// at most one button plus a More menu.
export function DestinationsPanel({ busy, onAction, onAdd, onForgetDrive, onKeys, onSelect, onShowKey, onStopUsing, running, views }: {
  busy: string;
  onAction: (view: DestinationView) => void;
  onAdd: () => void;
  onForgetDrive: (view: DestinationView) => void;
  onKeys: (archiveId: string, label: string) => void;
  onSelect: (view: DestinationView) => void;
  onShowKey: () => void;
  onStopUsing: (view: DestinationView) => void;
  running: boolean;
  views: DestinationView[];
}) {
  const locked = Boolean(busy) || running;
  // With nothing unplugged every reach line would say the same sentence.
  const showReach = views.some((view) => view.away);

  return <Panel>
    <PanelHead
      actions={<button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onAdd} type="button">
        <Icon name="plus" />
        Add destination
      </button>}
      title="This server's backups"
    >
      <p className="suite-meta">The places this server backs up to. Pick one for automatic backups. Storage itself is set up in <a className="mos-link" href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Settings → Storage</a>.</p>
    </PanelHead>

    <PanelList>{views.map((view) => {
      const working = [`release:${view.id}`, `primary:${view.id}`, `retest:${view.id}`, `forget-drive:${view.id}`].includes(busy);
      const own = view.destination.ownArchive;
      const menu = [
        ...own && view.selectable ? [{ label: 'Keys that open this', onSelect: () => onKeys(own.id, view.label) }] : [],
        ...!view.selected && !view.away ? [{ label: 'Stop using for backups', onSelect: () => onStopUsing(view) }] : [],
        // Only the memory of the drive goes; nothing on a drive that is not here changes.
        ...view.away && !view.selected && view.destination.kind === 'disk' ? [{ label: 'Forget this drive', onSelect: () => onForgetDrive(view) }] : [],
      ];
      return <PanelItem className={`suite-bk-row is-${view.tone}`} key={view.id} quiet={view.away} selected={view.selected}>
        <span className="suite-bk-row-pick">
          <Radio checked={view.selected} disabled={!view.selectable || locked} label={`Use ${view.label} for backups`} name="primary-destination" onChange={() => onSelect(view)} value={view.id} />
        </span>
        <div className="suite-bk-row-body">
          <div className="suite-bk-row-title">
            <span className="suite-bk-row-icon"><Icon name={destinationIconName(view.destination)} /></span>
            <strong>{view.label}</strong>
            <span className="suite-bk-kind">{view.kindLabel}</span>
          </div>
          <p className="suite-bk-status"><span className={`suite-bk-dot is-${view.tone}`} />{view.status}</p>
          {view.spaceLine ? <p className="suite-bk-detail">{view.spaceLine}</p> : null}
          {view.detail ? <p className="suite-bk-detail">{view.detail}</p> : null}
          {showReach ? <p className="suite-bk-detail">{view.reachLine}</p> : null}
          {view.selected ? <p className="suite-bk-selected-note">Automatic backups go here, including the one taken before a MOS update.</p> : null}
        </div>
        <div className="suite-bk-row-actions">
          {working ? <span className="suite-bk-working"><Spinner />Working</span> : null}
          {!working && view.actionLabel ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={() => onAction(view)} type="button">{view.actionLabel}</button> : null}
          {menu.length ? <ActionMenu ariaLabel={`More for ${view.label}`} disabled={locked} items={menu} /> : null}
        </div>
      </PanelItem>;
    })}</PanelList>

    {/* The key is a property of this list, so it closes it. */}
    <PanelBand icon="key" title="This server's recovery key opens these backups, and no others." tone="accent">
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onShowKey} type="button">
        <Icon name="eye" />
        Show key
      </button>
    </PanelBand>
  </Panel>;
}

// Archives other servers made, on storage connected here. They stay out of this
// server's own list until a restore takes over their key; unlocking only reads.
export function OtherServersPanel({ busy, onAction, onErase, onForgetKey, onKeys, running, views }: {
  busy: string;
  onAction: (view: OtherArchiveView) => void;
  onErase: (view: OtherArchiveView) => void;
  onForgetKey: (view: OtherArchiveView) => void;
  onKeys: (archiveId: string, label: string) => void;
  running: boolean;
  views: OtherArchiveView[];
}) {
  const locked = Boolean(busy) || running;
  const one = views.length === 1;
  return <Panel className="suite-bk-others">
    <PanelHead title={one ? 'Backups from another server' : 'Backups from other servers'}>
      <p className="suite-meta">{one ? 'These were made by another server.' : 'These were made by other servers.'} Unlock {one ? 'them' : 'one'} with the recovery key of the server that made {one ? 'them' : 'it'} to restore from {one ? 'them' : 'it'}. This server never backs up into them.</p>
    </PanelHead>
    <PanelList>{views.map((view) => {
      const working = busy === `unlock:${view.id}` || busy === `forget-key:${view.id}`;
      const borrowed = view.archive.keyState === 'borrowed';
      const menu = [
        ...borrowed ? [{ label: 'Keys that open this', onSelect: () => onKeys(view.id, view.label) }, { label: 'Lock again', onSelect: () => onForgetKey(view) }] : [],
        ...view.erasable ? [{ label: 'Erase these backups…', onSelect: () => onErase(view) }] : [],
      ];
      return <PanelItem className="suite-bk-row is-other-server" key={view.id}>
        <span className="suite-bk-row-lock"><Icon name="key" /></span>
        <div className="suite-bk-row-body">
          <div className="suite-bk-row-title">
            <span className="suite-bk-row-icon"><Icon name={destinationIconName(placeOf(view.archive.placeKind))} /></span>
            <strong>{view.label}</strong>
            <span className="suite-bk-kind">{view.kindLabel}</span>
            <span className="mos-pill">{borrowed ? 'Unlocked' : 'Locked'}</span>
            {view.from ? <span className="mos-chip mos-chip-info">From {view.from}</span> : null}
          </div>
          <p className="suite-bk-status"><span className={`suite-bk-dot is-${borrowed ? 'ready' : 'warning'}`} />{view.status}</p>
          <p className={`suite-bk-keyline is-${borrowed ? 'ready' : 'warning'}`}><Icon name="key" />{view.keyLine}</p>
        </div>
        <div className="suite-bk-row-actions">
          {working ? <span className="suite-bk-working"><Spinner />{busy.startsWith('unlock') ? 'Unlocking' : 'Working'}</span> : null}
          {!working ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={() => onAction(view)} type="button">{view.actionLabel}</button> : null}
          {menu.length ? <ActionMenu ariaLabel={`More for ${view.label}`} disabled={locked} items={menu} /> : null}
        </div>
      </PanelItem>;
    })}</PanelList>
  </Panel>;
}
