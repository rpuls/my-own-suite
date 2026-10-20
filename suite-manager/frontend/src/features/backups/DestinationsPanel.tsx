import { ActionMenu, Icon, Panel, PanelBand, PanelHead, PanelItem, PanelList, Spinner } from '../../components/ui';
import { openStorageSettings, STORAGE_SETTINGS_PATH } from '../storage/model';
import { destinationIconName, type DestinationView, type OtherArchiveView } from './model';

// The places this server backs up to. One list, one row per place, sorted so
// the selected one is first. A row has exactly three zones — the radio that
// chooses it, what it is and how it is doing, and at most one button plus a
// More menu — because the old screen had four affordances in four positions
// and nothing to read first.
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
  // Per-row reach lines only once there is a difference to show. With nothing
  // unplugged every row would say the same sentence, which reads as noise
  // rather than as the contrast it is there to draw.
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
        // Only the memory of the drive goes. MOS cannot write to a drive that is
        // not here, so nothing on it changes and plugging it back in lists it again.
        ...view.away && !view.selected && view.destination.kind === 'disk' ? [{ label: 'Forget this drive', onSelect: () => onForgetDrive(view) }] : [],
      ];
      return <PanelItem className={`suite-bk-row is-${view.tone}`} key={view.id} quiet={view.away} selected={view.selected}>
        <button
          aria-label={`Use ${view.label} for backups`}
          aria-pressed={view.selected}
          className="suite-bk-radio"
          disabled={!view.selectable || locked}
          onClick={() => onSelect(view)}
          type="button"
        >
          <span />
        </button>
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

    {/* The key is a property of this list, so it closes it: everything above
        it is this server's, and nothing from another server is in here. */}
    <PanelBand icon="key" title="This server's recovery key opens these backups, and no others." tone="accent">
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onShowKey} type="button">
        <Icon name="eye" />
        Show key
      </button>
    </PanelBand>
  </Panel>;
}

// Archives other servers made, on drives and in buckets connected here. They
// stay out of this server's own list until they become this server's — by a
// restore that takes over their key — because unlocking them only reads.
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
            <span className="suite-bk-row-icon"><Icon name={destinationIconName({ kind: view.archive.containerKind === 'object' ? 'object' : 'disk', storageKind: 'external' })} /></span>
            <strong>{view.label}</strong>
            <span className="suite-bk-kind">{view.kindLabel}</span>
            <span className="mos-pill">{borrowed ? 'Unlocked' : 'Locked'}</span>
            {view.from ? <span className="suite-bk-chip is-guest">From {view.from}</span> : null}
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
