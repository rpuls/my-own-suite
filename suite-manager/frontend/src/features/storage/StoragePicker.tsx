import type { ReactNode } from 'react';

import { Icon, Panel, PanelItem, PanelList, Spinner } from '../../components/ui';
import { pickerOffers, storageIcon, type PickerContext, type StorageEntry } from './model';

// The one way to choose storage, for an app's files and for backups alike. It shows
// what cannot be chosen too, with the reason, and always ends on adding more.
export function StoragePicker({ addHint, busy = false, context, empty = null, exclude = [], label, names, none = null, onAdd, onChange, question, storage, value, children }: {
  addHint: string;
  busy?: boolean;
  children?: ReactNode;
  context: PickerContext;
  // Said instead of the list when nothing at all could hold this.
  empty?: ReactNode;
  exclude?: string[];
  // The radio group's accessible name; the question is what is shown.
  label: string;
  names: Map<string, string>;
  none?: { facts: string; label: string } | null;
  onAdd: () => void;
  onChange: (storageId: string) => void;
  question: string;
  storage: StorageEntry[] | null;
  value: string;
}) {
  const offers = storage ? pickerOffers(storage, context, names, exclude) : [];
  const nothing = storage !== null && !offers.some((offer) => offer.selectable) && !none;
  const option = (id: string, body: ReactNode, { disabled = false, icon }: { disabled?: boolean; icon: Parameters<typeof Icon>[0]['name'] }) => <PanelItem flush key={id || 'none'} quiet={disabled} selected={value === id}>
    <label className={`suite-storage-option${disabled ? ' is-disabled' : ''}`}>
      <input checked={value === id} disabled={disabled || busy} name={label} onChange={() => onChange(id)} type="radio" value={id} />
      <span className="suite-storage-icon"><Icon name={icon} /></span>
      <span className="suite-storage-option-body">{body}</span>
    </label>
  </PanelItem>;

  return <div className="suite-storage-picker">
    <div>
      <h3 className="mos-card-title">{question}</h3>
      {children}
    </div>
    {storage === null ? <p className="suite-meta suite-storage-flow-working"><Spinner />Looking at what is plugged in…</p> : null}
    {nothing && empty ? <div className="suite-storage-empty">{empty}</div> : null}
    {storage !== null ? <Panel density="tight">
      <div aria-label={label} role="radiogroup">
        <PanelList>
          {none ? option('', <><strong>{none.label}</strong><span className="suite-meta">{none.facts}</span></>, { icon: 'x' }) : null}
          {offers.map((offer) => option(offer.entry.id, <>
            <strong>{offer.entry.name}</strong>
            <span className="suite-meta">{offer.facts}</span>
            {offer.warning ? <span className="suite-storage-warning">{offer.warning}</span> : null}
          </>, { disabled: !offer.selectable, icon: storageIcon(offer.entry) }))}
          <PanelItem flush>
            <button className="suite-storage-option is-add" disabled={busy} onClick={onAdd} type="button">
              <span className="suite-storage-icon"><Icon name="plus" /></span>
              <span className="suite-storage-option-body"><strong>Add storage…</strong><span className="suite-meta">{addHint}</span></span>
            </button>
          </PanelItem>
        </PanelList>
      </div>
    </Panel> : null}
  </div>;
}
