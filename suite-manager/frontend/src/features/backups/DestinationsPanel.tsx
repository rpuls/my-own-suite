import { ActionMenu, Icon, Spinner } from '../../components/ui';
import { destinationIconName, keyCoverage, type DestinationView, type RecoveryKeyState } from './model';

// Where backups go. One list, one row per place, sorted so the selected one is
// first. A row has exactly three zones — the radio that chooses it, what it is
// and how it is doing, and at most one button plus a More menu — because the
// old screen had four affordances in four positions and nothing to read first.
export function DestinationsPanel({ busy, keyState, onAdd, onAction, onDisconnect, onEdit, onSelect, onShowKey, running, views }: {
  busy: string;
  keyState: RecoveryKeyState | null;
  onAction: (view: DestinationView) => void;
  onAdd: () => void;
  onDisconnect: (view: DestinationView) => void;
  onEdit: (view: DestinationView) => void;
  onSelect: (view: DestinationView) => void;
  onShowKey: () => void;
  running: boolean;
  views: DestinationView[];
}) {
  const locked = Boolean(busy) || running;
  const coverage = keyCoverage(views, keyState);
  const local = views.filter((view) => !view.foreign && !view.destination.locked);
  const guests = views.filter((view) => view.foreign || view.destination.locked);

  const row = (view: DestinationView) => <DestinationRow
    busy={busy}
    key={view.id}
    locked={locked}
    onAction={() => onAction(view)}
    onDisconnect={() => onDisconnect(view)}
    onEdit={() => onEdit(view)}
    onSelect={() => onSelect(view)}
    view={view}
  />;

  return <section className="mos-panel suite-bk-panel">
    <div className="suite-bk-panel-head">
      <div>
        <p className="suite-bk-eyebrow">Where backups go</p>
        <p className="suite-meta">Pick one place. That is where automatic backups go.</p>
      </div>
      <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={locked} onClick={onAdd} type="button">
        <Icon name="plus" />
        Add destination
      </button>
    </div>

    <div className={`suite-bk-keyrow is-${coverage.tone}`}>
      <span className="suite-bk-keyrow-icon"><Icon name="key" /></span>
      <p>
        {coverage.summary}
        {coverage.detail ? <span className="suite-bk-keyrow-detail"> {coverage.detail}</span> : null}
      </p>
      <button className={`mos-btn mos-btn-${coverage.tone === 'warning' ? 'primary' : 'secondary'} mos-btn-sm`} disabled={locked} onClick={onShowKey} type="button">
        {keyState?.acknowledged ? 'Show key' : 'Show my key'}
      </button>
    </div>

    {views.length ? <div className="suite-bk-rows">
      {local.map(row)}
      {guests.length ? <div className="suite-bk-group-note">
        <span className="suite-bk-keyrow-icon"><Icon name="external" /></span>
        <span><strong>Brought in from other servers</strong> — each needs its own server&rsquo;s key once, then yours opens it too</span>
      </div> : null}
      {guests.map(row)}
    </div> : null}
  </section>;
}

function DestinationRow({ busy, locked, onAction, onDisconnect, onEdit, onSelect, view }: {
  busy: string;
  locked: boolean;
  onAction: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onSelect: () => void;
  view: DestinationView;
}) {
  const bucket = view.destination.kind === 'object';
  const working = busy === `mount:${view.id}` || busy === `unlock:${view.id}` || busy === `primary:${view.id}` || busy === `retest:${view.id}`;
  const menuItems = bucket ? [{ label: 'Edit connection', onSelect: onEdit }, { label: 'Disconnect', onSelect: onDisconnect }] : [];

  return <div className={`suite-bk-row is-${view.tone}${view.selected ? ' is-selected' : ''}${view.present ? '' : ' is-away'}`}>
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
  </div>;
}
