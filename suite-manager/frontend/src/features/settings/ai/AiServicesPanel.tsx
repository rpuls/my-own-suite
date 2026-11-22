import { useEffect, useState } from 'react';

import { ActionMenu, Avatar, Dialog, DisclosureRow, InfoTip, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, Rows, RowSwitch } from '../../../components/ui';
import { avatarOf } from '../../ai-activity/timeline';
import { AiDirectionPicture } from './AiDirectionPicture';
import { AiServiceDialog, answeredIn, type SavedService } from './AiServiceDialog';
import { aiServiceRequest, type AiService, type AiServiceApp, type AiServicesStatus, type AiServiceTest } from './model';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function hostOf(baseUrl: string) {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

function usedBy(service: AiService, apps: AiServiceApp[]) {
  const names = apps.filter((app) => app.serviceId === service.id).map((app) => app.name);
  return names.length ? `used by ${names.join(', ')}` : 'not used by an app yet';
}

function whereItGoes(service: AiService) {
  return service.locality === 'home'
    ? `An app you turn on here sends what it works on to ${hostOf(service.baseUrl)}, on your own network. Nothing leaves your home.`
    : `An app you turn on here sends what it works on to ${hostOf(service.baseUrl)}, on the internet. Apps you leave off send nothing.`;
}

function RemoveServiceDialog({ busy, onClose, onRemove, service, users }: { busy: boolean; onClose: () => void; onRemove: () => void; service: AiService; users: AiServiceApp[] }) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing...' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove ${service.name}?`}
  >
    <p>MOS forgets this service and its key.{users.length ? ` ${users.map((app) => app.name).join(', ')} ${users.length === 1 ? 'loses its' : 'lose their'} AI features and ${users.length === 1 ? 'restarts' : 'restart'}.` : ''}</p>
  </Dialog>;
}

function ServiceItem({ apps, busy, expanded, onEdit, onRemove, onSwitch, onTest, onToggle, service, switching, tested }: {
  apps: AiServiceApp[];
  busy: boolean;
  expanded: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSwitch: (app: AiServiceApp, on: boolean) => void;
  onTest: () => void;
  onToggle: () => void;
  service: AiService;
  switching: string;
  tested: AiServiceTest | null;
}) {
  const place = service.locality === 'home' ? 'On your network' : hostOf(service.baseUrl);
  return <PanelItem flush>
    <DisclosureRow expanded={expanded} label={`${expanded ? 'Hide' : 'Show'} which apps use ${service.name}`} onToggle={onToggle} trailing={<>
      {service.test.error ? <span className="mos-pill mos-pill-warning">Not answering</span> : null}
      <ActionMenu ariaLabel={`More for ${service.name}`} disabled={busy} items={[
        { label: 'Test', onSelect: onTest },
        { label: 'Change', onSelect: onEdit },
        { label: 'Remove', onSelect: onRemove },
      ]} />
    </>}>
      <span className="suite-source-main">
        <strong className="suite-ai-client-name">{service.name}<Avatar {...avatarOf(service.name)} small /></strong>
        <span className="suite-meta">{place} · {service.model} · {usedBy(service, apps)}</span>
      </span>
    </DisclosureRow>
    {expanded ? <div className="suite-ai-grants">
      {tested?.ok ? <Notice title="It works" variant="success"><p>{answeredIn(tested.ms)}</p></Notice> : null}
      {!tested?.ok && service.test.error ? <Notice title={`${service.name} did not answer the last test`} variant="warning"><p>{service.test.error}</p></Notice> : null}
      {apps.length ? <>
        <Rows>
          {apps.map((app) => <RowSwitch
            checked={app.serviceId === service.id}
            description={switching === app.packageId ? `Restarting ${app.name}...` : app.running ? undefined : `${app.name} is stopped. It uses this when it next starts.`}
            disabled={busy}
            key={app.packageId}
            label={app.name}
            onChange={(event) => onSwitch(app, event.target.checked)}
          />)}
        </Rows>
        <p className="suite-meta">{whereItGoes(service)}</p>
      </> : <p className="suite-meta">None of your installed apps can use an AI service yet.</p>}
    </div> : null}
  </PanelItem>;
}

// The AI services the owner's apps may call, and which app uses which. Flipping
// an app's switch restarts that app, because that is how it receives the service.
export function AiServicesPanel() {
  const [status, setStatus] = useState<AiServicesStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState('');
  const [open, setOpen] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiService | null>(null);
  const [removing, setRemoving] = useState<AiService | null>(null);
  const [tested, setTested] = useState<{ id: string; test: AiServiceTest } | null>(null);

  useEffect(() => {
    aiServiceRequest('GET', '', 'Unable to load your AI services.').then(setStatus, (caught) => setError(errorText(caught, 'Unable to load your AI services.')));
  }, []);

  function notRestarted(names: string[] | undefined) {
    setError(names?.length ? `${names.join(', ')} could not be restarted. Restart ${names.length === 1 ? 'it' : 'them'} from the Apps page to apply the change.` : '');
  }

  async function run<T>(action: () => Promise<T>, fallback: string, done: (result: T) => void) {
    setBusy(true);
    setError('');
    try {
      done(await action());
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
      setSwitching('');
    }
  }

  function saved({ restartFailures, status: next, test }: SavedService) {
    const id = editing?.id ?? next.services[next.services.length - 1]?.id ?? '';
    setStatus(next);
    setTested(id ? { id, test } : null);
    setOpen(id);
    setAdding(false);
    setEditing(null);
    notRestarted(restartFailures);
  }

  const services = status?.services ?? [];
  const apps = status?.apps ?? [];

  return <Panel>
    <PanelHead actions={status ? <button className={`mos-btn ${services.length ? 'mos-btn-secondary' : 'mos-btn-primary'}`} disabled={busy} onClick={() => setAdding(true)} type="button">Add</button> : null} heading="h3" title={<>AI services<InfoTip label="What AI services are" picture={<AiDirectionPicture direction="out" />} title="Let your apps use AI">
      <p>Give your suite an AI service to call. Apps that have AI features then use it by themselves, for things like suggestions and summaries. Each app stays off until you turn it on.</p>
    </InfoTip></>}>
      <p>Add an AI service once. Apps that have AI features use it, with nothing to set up inside each app.</p>
    </PanelHead>
    {error ? <PanelBody><Notice title="Something went wrong" variant="error"><p>{error}</p></Notice></PanelBody> : null}
    {services.length ? <PanelList>
      {services.map((service) => <ServiceItem
        apps={apps}
        busy={busy}
        expanded={open === service.id}
        key={service.id}
        onEdit={() => setEditing(service)}
        onRemove={() => setRemoving(service)}
        onSwitch={(app, on) => {
          setSwitching(app.packageId);
          void run(() => aiServiceRequest('PUT', `/apps/${encodeURIComponent(app.packageId)}`, `${app.name} could not be changed.`, { serviceId: on ? service.id : null }), `${app.name} could not be changed.`, setStatus);
        }}
        onTest={() => {
          setOpen(service.id);
          void run(() => aiServiceRequest<{ status: AiServicesStatus; test: AiServiceTest }>('POST', `/${service.id}/test`, 'The service could not be tested.'), 'The service could not be tested.', (result) => {
            setStatus(result.status);
            setTested({ id: service.id, test: result.test });
          });
        }}
        onToggle={() => setOpen(open === service.id ? '' : service.id)}
        service={service}
        switching={switching}
        tested={tested?.id === service.id ? tested.test : null}
      />)}
    </PanelList> : status ? <PanelBody>
      <p className="suite-meta">No AI service yet. Add a model you run at home, or one on the internet, to let your apps use it.</p>
    </PanelBody> : null}
    {adding || editing ? <AiServiceDialog onClose={() => { setAdding(false); setEditing(null); }} onSaved={saved} service={editing ?? undefined} /> : null}
    {removing ? <RemoveServiceDialog
      busy={busy}
      onClose={() => setRemoving(null)}
      onRemove={() => void run(() => aiServiceRequest<{ restartFailures: string[]; status: AiServicesStatus }>('DELETE', `/${removing.id}`, 'The AI service could not be removed.'), 'The AI service could not be removed.', (result) => {
        setStatus(result.status);
        setRemoving(null);
        notRestarted(result.restartFailures);
      })}
      service={removing}
      users={apps.filter((app) => app.serviceId === removing.id)}
    /> : null}
  </Panel>;
}
