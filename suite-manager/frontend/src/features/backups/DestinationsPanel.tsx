import { ActionMenu, Icon, Panel, PanelBand, PanelHead, PanelItem, PanelList, Spinner } from '../../components/ui';
import { openStorageSettings, STORAGE_SETTINGS_PATH } from '../storage/model';
import { destinationIconName, type DestinationView } from './model';

// Where backups go. One list, one row per place, sorted so the selected one is
// first. A row has exactly three zones — the radio that chooses it, what it is
// and how it is doing, and at most one button plus a More menu — because the
// old screen had four affordances in four positions and nothing to read first.
export function DestinationsPanel({ busy, onAdd, onAction, onErase, onForgetDrive, onForgetKey, onKeys, onSelect, onShowKey, onStopUsing, running, views }: {
  busy: string;
  onAction: (view: DestinationView) => void;
  onAdd: () => void;
  onErase: (view: DestinationView) => void;
  onForgetDrive: (view: DestinationView) => void;
  onForgetKey: (view: DestinationView) => void;
  onKeys: (view: DestinationView) => void;
  onSelect: (view: DestinationView) => void;
  onShowKey: () => void;
  onStopUsing: (view: DestinationView) => void;
  running: boolean;
  views: DestinationView[];
}) {
  const locked = Boolean(busy) || running;
  const guest = (view: DestinationView) => Boolean(view.foreign || view.destination.foreignStore);
  const local = views.filter((view) => !guest(view));
  const guests = views.filter(guest);
  // Per-row reach lines only once there is a difference to show. With nothing
  // unplugged every row would say the same sentence, which reads as noise
  // rather than as the contrast it is there to draw.
  const showReach = views.some((view) => view.away);

  const row = (view: DestinationView) => <DestinationRow
    busy={busy}
    key={view.id}
    locked={locked}
    showReach={showReach}
    onAction={() => onAction(view)}
    onErase={() => onErase(view)}
    onForgetDrive={() => onForgetDrive(view)}
    onForgetKey={() => onForgetKey(view)}
    onKeys={() => onKeys(view)}
    onSelect={() => onSelect(view)}
    onStopUsing={() => onStopUsing(view)}
    view={view}
  />;

  return <Panel>
    <PanelHead
      actions={<button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onAdd} type="button">
        <Icon name="plus" />
        Add destination
      </button>}
      title="Where backups go"
    >
      <p className="suite-meta">Pick one place. That is where automatic backups go. Storage itself is set up in <a className="mos-link" href={STORAGE_SETTINGS_PATH} onClick={openStorageSettings}>Settings → Storage</a>.</p>
    </PanelHead>

    {/* The key is a property of the list, so it sits against it: the owner
        reads the places, then reads which key opens them. */}
    <PanelBand icon="key" title="One recovery key opens everything this server made." tone="accent">
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onShowKey} type="button">
        <Icon name="eye" />
        Show key
      </button>
    </PanelBand>

    {local.length ? <PanelList>{local.map(row)}</PanelList> : null}

    {guests.length ? <>
      <PanelBand
        icon="external"
        note="each opens with the key of the server that wrote it"
        title="Brought in from other servers"
        tone="info"
      />
      <PanelList>{guests.map(row)}</PanelList>
    </> : null}
  </Panel>;
}

function DestinationRow({ busy, locked, onAction, onErase, onForgetDrive, onForgetKey, onKeys, onSelect, onStopUsing, showReach, view }: {
  busy: string;
  locked: boolean;
  onAction: () => void;
  onErase: () => void;
  onForgetDrive: () => void;
  onForgetKey: () => void;
  onKeys: () => void;
  onSelect: () => void;
  onStopUsing: () => void;
  showReach: boolean;
  view: DestinationView;
}) {
  const working = busy === `release:${view.id}` || busy === `unlock:${view.id}` || busy === `primary:${view.id}` || busy === `retest:${view.id}`;
  const menuItems = [
    ...view.readable ? [{ label: 'Keys that open this', onSelect: onKeys }] : [],
    ...view.destination.borrowedKey ? [{ label: 'Forget this key', onSelect: onForgetKey }] : [],
    ...view.erasable ? [{ label: 'Erase these backups…', onSelect: onErase }] : [],
    ...!view.selected && view.present ? [{ label: 'Stop using for backups', onSelect: onStopUsing }] : [],
    // Only the memory of the drive goes. MOS cannot write to a drive that is
    // not here, so nothing on it changes and plugging it back in lists it again.
    ...view.away ? [{ label: 'Forget this drive', onSelect: onForgetDrive }] : [],
  ];

  return <PanelItem className={`suite-bk-row is-${view.tone}`} quiet={!view.present} selected={view.selected}>
    <button
      aria-label={`Use ${view.label} for backups`}
      aria-pressed={view.selected}
      className="suite-bk-radio"
      disabled={!view.selectable || locked}
      onClick={onSelect}
      type="button"
    >
      <span />
    </button>

    <div className="suite-bk-row-body">
      <div className="suite-bk-row-title">
        <span className="suite-bk-row-icon"><Icon name={destinationIconName(view.destination)} /></span>
        <strong>{view.label}</strong>
        <span className="suite-bk-kind">{view.kindLabel}</span>
        {view.foreign ? <span className="suite-bk-chip is-guest">From {view.foreign}</span> : null}
      </div>

      <p className="suite-bk-status"><span className={`suite-bk-dot is-${view.tone}`} />{view.status}</p>
      {view.spaceLine ? <p className="suite-bk-detail">{view.spaceLine}</p> : null}
      {view.detail ? <p className="suite-bk-detail">{view.detail}</p> : null}
      {view.keyLine ? <p className={`suite-bk-keyline is-${view.keyTone}`}><Icon name="key" />{view.keyLine}</p> : null}
      {showReach && view.reachLine ? <p className="suite-bk-detail">{view.reachLine}</p> : null}
      {view.selected ? <p className="suite-bk-selected-note">Automatic backups go here, including the one taken before a MOS update.</p> : null}
    </div>

    <div className="suite-bk-row-actions">
      {working ? <span className="suite-bk-working"><Spinner />{busy.startsWith('unlock') ? 'Unlocking' : 'Working'}</span> : null}
      {!working && view.actionLabel ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onAction} type="button">{view.actionLabel}</button> : null}
      {menuItems.length ? <ActionMenu ariaLabel={`More for ${view.label}`} disabled={locked} items={menuItems} /> : null}
    </div>
  </PanelItem>;
}
