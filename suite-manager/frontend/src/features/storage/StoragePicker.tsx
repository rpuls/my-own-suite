import type { ReactNode } from 'react';

import { ChoiceRow, Panel, PanelItem, PanelList, Spinner } from '../../components/ui';
import { pickerOffers, storageIcon, type AppNames, type PickerContext, type StorageEntry } from './model';

// The one way to choose storage, for an app's files and for backups alike. It shows
// what cannot be chosen too, with the reason, and always ends on adding more.
export function StoragePicker({ addHint, backupsKnown, busy = false, context, empty = null, exclude = [], label, names, none = null, onAdd, onChange, question, storage, value, children }: {
  addHint: string;
  backupsKnown: boolean;
  busy?: boolean;
  children?: ReactNode;
  context: PickerContext;
  // Said instead of the list when nothing at all could hold this.
  empty?: ReactNode;
  exclude?: string[];
  // The radio group's accessible name; the question is what is shown.
  label: string;
  names: AppNames;
  none?: { facts: string; label: string } | null;
  onAdd: () => void;
  onChange: (storageId: string) => void;
  question: string;
  storage: StorageEntry[] | null;
  value: string;
}) {
  const offers = storage ? pickerOffers(storage, context, { backupsKnown, exclude, names }) : [];
  const nothing = storage !== null && !offers.some((offer) => offer.selectable) && !none;

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
          {none ? <PanelItem flush selected={value === ''}>
            <ChoiceRow disabled={busy} icon="x" radio={{ checked: value === '', name: label, onChange: () => onChange(''), value: '' }}>
              <strong>{none.label}</strong>
              <span className="suite-meta">{none.facts}</span>
            </ChoiceRow>
          </PanelItem> : null}
          {offers.map((offer) => <PanelItem flush key={offer.entry.id} quiet={!offer.selectable} selected={value === offer.entry.id}>
            <ChoiceRow disabled={!offer.selectable || busy} icon={storageIcon(offer.entry)} radio={{ checked: value === offer.entry.id, name: label, onChange: () => onChange(offer.entry.id), value: offer.entry.id }}>
              <strong>{offer.entry.name}</strong>
              <span className="suite-meta">{offer.facts}</span>
              {offer.warning ? <span className="suite-storage-warning">{offer.warning}</span> : null}
            </ChoiceRow>
          </PanelItem>)}
          <PanelItem flush>
            <ChoiceRow accent disabled={busy} icon="plus" onPick={onAdd}>
              <strong>Add storage…</strong>
              <span className="suite-meta">{addHint}</span>
            </ChoiceRow>
          </PanelItem>
        </PanelList>
      </div>
    </Panel> : null}
  </div>;
}
