import { useEffect, useState } from 'react';

import { Dialog, Icon, IconTile, Notice, Row, RowAction, RowTrailing, Rows } from '../../../components/ui';
import { lowerFirst, whenWords } from '../../../lib/dates';
import { SourceTokenDialog } from './AiParts';
import { aiRequest, aiServiceRequest, LEVEL_OPTIONS, levelOf, type AiClient, type AiService, type AiServiceApp, type AiServicesStatus, type AiSource, type AiStatus } from './model';
import { placeWords } from './service-words';

const ASSISTANTS_PATH = '/suite-manager/settings#set-ai';
const SERVICES_PATH = '/suite-manager/settings#set-ai-services';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function levelWords(client: AiClient, sourceId: string) {
  const level = levelOf(client, sourceId);
  return LEVEL_OPTIONS.find((option) => option.value === level)?.label ?? level;
}

function SettingsLink({ children, href }: { children: string; href: string }) {
  return <a className="mos-link suite-settings-link" href={href}>{children}<Icon name="arrow-right" /></a>;
}

function RemoveTokenDialog({ allowed, busy, onClose, onRemove, source }: { allowed: AiClient[]; busy: boolean; onClose: () => void; onRemove: () => void; source: AiSource }) {
  const who = allowed.map((client) => client.name).join(', ');
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing...' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove the ${source.name} token?`}
  >
    <p>{allowed.length ? `${who} can no longer use ${source.name} until you add a new token.` : `No assistant can use ${source.name} until you add a new token.`} To stop it working in {source.name} too, delete the token there as well.</p>
  </Dialog>;
}

function AssistantsRow({ allowed, source }: { allowed: AiClient[]; source: AiSource }) {
  const who = allowed.map((client) => `${client.name} · ${levelWords(client, source.id)}`).join(', ');
  return <Row help={who || 'None yet'} label={<><IconTile icon="chat-spark" />AI assistants that may use it</>}>
    <SettingsLink href={ASSISTANTS_PATH}>AI assistants</SettingsLink>
  </Row>;
}

function ServiceRow({ app, services }: { app: AiServiceApp; services: AiService[] }) {
  const service = services.find((candidate) => candidate.id === app.serviceId);
  const label = <><IconTile icon="chip-spark" />AI service it asks{app.reviewInvalidated ? <> <span className="mos-pill mos-pill-warning">Experimental</span></> : null}</>;
  if (!service) {
    return <Row help="None yet" label={label}><SettingsLink href={SERVICES_PATH}>Set one up under AI in your apps</SettingsLink></Row>;
  }
  return <Row help={`${service.name} · ${service.test.error ? 'Last test failed' : placeWords(service)}`} label={label}>
    <SettingsLink href={SERVICES_PATH}>AI in your apps</SettingsLink>
  </Row>;
}

// On an app's own page: the assistants that may use it, the AI service it asks, and the
// access token the app gave MOS. Both are still chosen under Settings.
export function AiAppAccess({ packageId }: { packageId: string }) {
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  const [services, setServices] = useState<AiServicesStatus | null | undefined>(undefined);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    aiRequest('GET', '', 'Unable to load AI assistants.').then(setStatus, () => setStatus(null));
    aiServiceRequest('GET', '', 'Unable to load AI in your apps.').then(setServices, () => setServices(null));
  }, [packageId]);

  if (status === undefined || services === undefined) return null;
  const source = status?.sources.find((candidate) => candidate.id === packageId);
  const serviceApp = services?.apps.find((candidate) => candidate.packageId === packageId);
  if (!source && !serviceApp) return null;
  const allowed = source && status ? status.clients.filter((client) => client.enabled && levelOf(client, source.id) !== 'off') : [];

  async function change(action: () => Promise<AiStatus>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      setStatus(await action());
      setReplacing(false);
      setRemoving(false);
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  const tokenPath = source ? `/sources/${encodeURIComponent(source.id)}/token` : '';
  const savedAt = source?.token?.verifiedAt;
  return <section className="suite-app-detail-section">
    <h3>AI</h3>
    <Rows lead>
      {source ? <AssistantsRow allowed={allowed} source={source} /> : null}
      {source?.token?.configured ? <Row help={savedAt ? `Saved ${lowerFirst(whenWords(savedAt))}.` : 'Saved.'} label={`${source.name} access token`}>
        <RowTrailing>
          <RowAction disabled={busy} icon="key" label={`Replace the ${source.name} token`} onClick={() => { setError(''); setReplacing(true); }} />
          <RowAction danger disabled={busy} icon="x" label={`Remove the ${source.name} token`} onClick={() => { setError(''); setRemoving(true); }} />
        </RowTrailing>
      </Row> : null}
      {serviceApp && services ? <ServiceRow app={serviceApp} services={services.services} /> : null}
    </Rows>
    {error && !replacing ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
    {replacing && source ? <SourceTokenDialog busy={busy} error={error} onClose={() => setReplacing(false)} onSave={(token) => void change(() => aiRequest('PUT', tokenPath, 'The token could not be saved.', { token }), 'The token could not be saved.')} source={source} /> : null}
    {removing && source ? <RemoveTokenDialog allowed={allowed} busy={busy} onClose={() => setRemoving(false)} onRemove={() => void change(() => aiRequest('DELETE', tokenPath, 'The token could not be removed.'), 'The token could not be removed.')} source={source} /> : null}
  </section>;
}
