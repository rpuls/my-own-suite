import { ActionMenu, Icon, Panel, PanelBand, PanelHead, PanelItem, PanelList, Spinner } from '../../components/ui';
import { destinationIconName, keyCoverage, type DestinationView } from './model';

// Where backups go. One list, one row per place, sorted so the selected one is
// first. A row has exactly three zones — the radio that chooses it, what it is
// and how it is doing, and at most one button plus a More menu — because the
// old screen had four affordances in four positions and nothing to read first.
export function DestinationsPanel({ busy, onAdd, onAction, onDisconnect, onEdit, onForgetKey, onKeys, onSelect, onShowKey, running, views }: {
  busy: string;
  onAction: (view: DestinationView) => void;
  onAdd: () => void;
  onDisconnect: (view: DestinationView) => void;
  onEdit: (view: DestinationView) => void;
  onForgetKey: (view: DestinationView) => void;
  onKeys: (view: DestinationView) => void;
  onSelect: (view: DestinationView) => void;
  onShowKey: () => void;
  running: boolean;
  views: DestinationView[];
}) {
  const locked = Boolean(busy) || running;
  const coverage = keyCoverage(views);
  const local = views.filter((view) => !view.foreign && !view.destination.locked);
  const guests = views.filter((view) => view.foreign || view.destination.locked);

  const row = (view: DestinationView) => <DestinationRow
    busy={busy}
    key={view.id}
    locked={locked}
    onAction={() => onAction(view)}
    onDisconnect={() => onDisconnect(view)}
    onEdit={() => onEdit(view)}
    onForgetKey={() => onForgetKey(view)}
    onKeys={() => onKeys(view)}
    onSelect={() => onSelect(view)}
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
      <p className="suite-meta">Pick one place. That is where automatic backups go.</p>
    </PanelHead>

    {/* The key is a property of the list, so it sits against it: the owner
        reads the places, then reads which key opens them. */}
    <PanelBand icon="key" note={coverage.detail} title={coverage.summary} tone="accent">
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

function DestinationRow({ busy, locked, onAction, onDisconnect, onEdit, onForgetKey, onKeys, onSelect, view }: {
  busy: string;
  locked: boolean;
  onAction: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onForgetKey: () => void;
  onKeys: () => void;
  onSelect: () => void;
  view: DestinationView;
}) {
  const bucket = view.destination.kind === 'object';
  const working = busy === `mount:${view.id}` || busy === `unlock:${view.id}` || busy === `primary:${view.id}` || busy === `retest:${view.id}`;
  const menuItems = [
    ...bucket ? [{ label: 'Edit connection', onSelect: onEdit }] : [],
    ...view.selectable ? [{ label: 'Keys that open this', onSelect: onKeys }] : [],
    ...view.destination.borrowedKey ? [{ label: 'Forget this key', onSelect: onForgetKey }] : [],
    ...bucket ? [{ label: 'Disconnect', onSelect: onDisconnect }] : [],
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
      {view.selected ? <p className="suite-bk-selected-note">Automatic backups go here, including the one taken before a MOS update.</p> : null}
    </div>

    <div className="suite-bk-row-actions">
      {working ? <span className="suite-bk-working"><Spinner />{busy.startsWith('unlock') ? 'Unlocking' : busy.startsWith('mount') ? 'Opening' : 'Working'}</span> : null}
      {!working && view.actionLabel ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onAction} type="button">{view.actionLabel}</button> : null}
      {menuItems.length ? <ActionMenu ariaLabel={`More for ${view.label}`} disabled={locked} items={menuItems} /> : null}
    </div>
  </PanelItem>;
}
