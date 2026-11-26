import { Dialog, DestinationLine } from '../../../components/ui';
import type { AiService, AiServiceApp } from './model';
import { consentAfter, consentButton, consentFlow, consentTitle, PLACE_CLAUSE, removeBody, type SwitchKind } from './service-words';

export type PendingSwitch = { app: AiServiceApp; on: boolean; previous: AiService | null; service: AiService };

function kindOf({ on, previous }: PendingSwitch): SwitchKind {
  if (!on) return 'off';
  return previous ? 'move' : 'on';
}

// The consent moment: shown for every flip, also of a stopped app, because data starts to flow on this click.
export function SwitchConfirmDialog({ onClose, onConfirm, pending }: { onClose: () => void; onConfirm: () => void; pending: PendingSwitch }) {
  const { app, previous, service } = pending;
  const kind = kindOf(pending);
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" onClick={onConfirm} type="button">{consentButton(kind, app.running)}</button>
    </>}
    onClose={onClose}
    title={consentTitle(kind, app, service)}
  >
    {kind === 'off' ? null : <DestinationLine variant={service.place}>
      <span className="mos-destination-line">{consentFlow(app, service)}</span>
      <span className="mos-destination-line">{PLACE_CLAUSE[service.place]}</span>
    </DestinationLine>}
    {previous && kind === 'move' ? <p>It stops asking {previous.name}.</p> : null}
    <p>{consentAfter(kind, app, service)}</p>
  </Dialog>;
}

export function RemoveServiceDialog({ busy, onClose, onRemove, service, users }: { busy: boolean; onClose: () => void; onRemove: () => void; service: AiService; users: AiServiceApp[] }) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing…' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove ${service.name}?`}
  >
    <p>{removeBody(users)}</p>
  </Dialog>;
}
