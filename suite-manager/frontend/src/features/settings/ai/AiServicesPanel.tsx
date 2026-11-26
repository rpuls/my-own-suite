import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AiDirectionPicture, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelHeadButton, PanelHeadHood, PanelList, PendingLine, PendingRow } from '../../../components/ui';
import { AI_IN_APPS_GUIDE_URL } from '../../../lib/links';
import { RemoveServiceDialog, SwitchConfirmDialog, type PendingSwitch } from './AiServiceConfirm';
import { AiServiceDialog } from './AiServiceDialog';
import { ServiceItem, type SwitchError } from './AiServiceItem';
import { aiServiceRequest, type AiService, type AiServiceApp, type AiServicesStatus, type AiServiceTest, type ServiceChange } from './model';
import { HEAD_FIRST_SENTENCE, headLead, HOOD_LINE, notRestartedAfterRemove, usersOf } from './service-words';

const LOAD_FAILED = 'Could not load this.';
const STALE_MS = 15 * 60_000;

function isStale(service: AiService) {
  return !service.test.at || Date.now() - Date.parse(service.test.at) > STALE_MS;
}

// Takes only the one service's test from a status, so a check never undoes a change made meanwhile.
function withTestOf(current: AiServicesStatus, fresh: AiServicesStatus, id: string): AiServicesStatus {
  const test = fresh.services.find((service) => service.id === id)?.test;
  return test ? { ...current, services: current.services.map((service) => service.id === id ? { ...service, test } : service) } : current;
}

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function ServicesHead({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return <PanelHead actions={actions} figure={<AiDirectionPicture direction="out" size="md" />} heading="h3" title="AI in your apps">{children}</PanelHead>;
}

function HoodLine() {
  return <PanelHeadHood>{HOOD_LINE}</PanelHeadHood>;
}

function PendingServicesPanel() {
  return <Panel className="mos-pending">
    <ServicesHead><PendingLine width="90%" /><PendingLine width="30%" /><PendingLine width="74%" /></ServicesHead>
    <PanelList>
      <PendingRow lead="tile" meta="70%" name="26%" />
      <PendingRow lead="tile" meta="58%" name="20%" />
    </PanelList>
  </Panel>;
}

// No app list and no Add: both come from the status that failed.
function FailedServicesPanel({ onRetry }: { onRetry: () => void }) {
  return <Panel>
    <ServicesHead><p>{HEAD_FIRST_SENTENCE}</p><HoodLine /></ServicesHead>
    <PanelBand icon="alert" layout="row" title="Could not load this." tone="warning">
      <button className="mos-btn mos-btn-secondary" onClick={onRetry} type="button">Try again</button>
    </PanelBand>
  </Panel>;
}

function EmptyServices({ apps }: { apps: AiServiceApp[] }) {
  const link = (href: string, words: string) => <a className="mos-link suite-settings-link" href={href} rel="noreferrer" target="_blank">{words}<Icon name="arrow-right" /></a>;
  return <PanelBody>
    {apps.length
      ? <p className="suite-meta">No AI service yet. Add one, a model on your own computer or a provider&apos;s API (a chat subscription is not one), then turn it on for each app that should ask it. {link(AI_IN_APPS_GUIDE_URL, 'How it works')}</p>
      : <p className="suite-meta">No AI service yet. Apps that can ask one show up here when you install them. {link(`${AI_IN_APPS_GUIDE_URL}#which-apps-ask-it-and-for-what`, 'Which apps can')}</p>}
  </PanelBody>;
}

function NotRestartedNotice({ names, service }: { names: string[]; service: string }) {
  const words = notRestartedAfterRemove(names, service);
  return <Notice title={words.title} variant="warning">
    <p>{words.body} <a className="mos-link suite-settings-link" href="/suite-manager/apps">{words.link}<Icon name="arrow-right" /></a></p>
  </Notice>;
}

// The AI services the owner's apps may ask, and which app asks which. Flipping an
// app's switch restarts that app, because that is how it receives the service.
export function AiServicesPanel() {
  const [status, setStatus] = useState<AiServicesStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState('');
  const [testing, setTesting] = useState('');
  const [checking, setChecking] = useState('');
  const checked = useRef(false);
  const [open, setOpen] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiService | null>(null);
  const [removing, setRemoving] = useState<AiService | null>(null);
  const [tested, setTested] = useState<{ id: string; test: AiServiceTest } | null>(null);
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [switchError, setSwitchError] = useState<SwitchError | null>(null);
  const [restartFailed, setRestartFailed] = useState<{ packageIds: string[]; serviceId: string } | null>(null);
  const [removeFailed, setRemoveFailed] = useState<{ names: string[]; service: string } | null>(null);

  function load() {
    setLoadFailed(false);
    aiServiceRequest('GET', '', LOAD_FAILED).then((next) => {
      setStatus(next);
      if (!checked.current) {
        checked.current = true;
        void checkStale(next.services);
      }
    }, () => setLoadFailed(true));
  }

  // One at a time and without locking the card: the owner can work on while a slow model answers.
  async function checkStale(services: AiService[]) {
    for (const service of services.filter(isStale)) {
      setChecking(service.id);
      try {
        const result = await aiServiceRequest<{ status: AiServicesStatus }>('POST', `/${service.id}/test`, 'The service could not be tested.');
        setStatus((current) => current && withTestOf(current, result.status, service.id));
      } catch {
        // The row keeps the test it had.
      }
    }
    setChecking('');
  }

  useEffect(load, []);

  // Each new change clears what the last one left behind.
  function startChange() {
    setBusy(true);
    setError('');
    setSwitchError(null);
    setRestartFailed(null);
    setRemoveFailed(null);
  }

  async function applySwitch({ app, on, service }: PendingSwitch) {
    setPending(null);
    startChange();
    setSwitching(app.packageId);
    try {
      setStatus(await aiServiceRequest('PUT', `/apps/${encodeURIComponent(app.packageId)}`, `${app.name} could not be changed.`, { serviceId: on ? service.id : null }));
    } catch (caught) {
      setSwitchError({ message: errorText(caught, `${app.name} could not be changed.`), packageId: app.packageId, serviceId: service.id });
    } finally {
      setBusy(false);
      setSwitching('');
    }
  }

  async function testService(service: AiService) {
    setOpen(service.id);
    setBusy(true);
    setError('');
    setTesting(service.id);
    try {
      const result = await aiServiceRequest<{ status: AiServicesStatus; test: AiServiceTest }>('POST', `/${service.id}/test`, 'The service could not be tested.');
      setStatus(result.status);
      setTested({ id: service.id, test: result.test });
    } catch (caught) {
      setTested(null);
      setError(errorText(caught, 'The service could not be tested.'));
    } finally {
      setBusy(false);
      setTesting('');
    }
  }

  async function removeService(service: AiService) {
    startChange();
    try {
      const result = await aiServiceRequest<ServiceChange>('DELETE', `/${service.id}`, 'The AI service could not be removed.');
      setStatus(result.status);
      setRemoving(null);
      const names = result.status.apps.filter((app) => result.restartFailures.includes(app.packageId)).map((app) => app.name);
      if (names.length) setRemoveFailed({ names, service: service.name });
    } catch (caught) {
      setError(errorText(caught, 'The AI service could not be removed.'));
    } finally {
      setBusy(false);
    }
  }

  function saved({ restartFailures, status: next, test }: ServiceChange) {
    const id = editing?.id ?? next.services.find((service) => !status?.services.some((known) => known.id === service.id))?.id ?? '';
    setStatus(next);
    setTested(id && test ? { id, test } : null);
    setOpen(id);
    setAdding(false);
    setEditing(null);
    setSwitchError(null);
    setRestartFailed(restartFailures.length ? { packageIds: restartFailures, serviceId: id } : null);
  }

  function askToSwitch(app: AiServiceApp, on: boolean, service: AiService) {
    const previous = on ? status?.services.find((candidate) => candidate.id === app.serviceId && candidate.id !== service.id) ?? null : null;
    setPending({ app, on, previous, service });
  }

  if (loadFailed) return <FailedServicesPanel onRetry={load} />;
  if (!status) return <PendingServicesPanel />;
  const { apps, services } = status;

  return <Panel className="mos-arrive">
    <ServicesHead actions={<PanelHeadButton accessibleLabel="Add an AI service" disabled={busy} onClick={() => setAdding(true)}>Add</PanelHeadButton>}>
      <p>{headLead(apps)}</p>
      <HoodLine />
    </ServicesHead>
    {error || removeFailed ? <PanelBody>
      {error ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
      {removeFailed ? <NotRestartedNotice names={removeFailed.names} service={removeFailed.service} /> : null}
    </PanelBody> : null}
    {services.length ? <PanelList>
      {services.map((service) => <ServiceItem
        apps={apps}
        busy={busy}
        checking={checking === service.id}
        expanded={open === service.id}
        key={service.id}
        onEdit={() => setEditing(service)}
        onRemove={() => setRemoving(service)}
        onSwitch={(app, on) => askToSwitch(app, on, service)}
        onTest={() => void testService(service)}
        onToggle={() => setOpen(open === service.id ? '' : service.id)}
        restartFailed={restartFailed?.serviceId === service.id ? restartFailed.packageIds : []}
        service={service}
        services={services}
        switchError={switchError}
        switching={switching}
        tested={tested?.id === service.id ? tested.test : null}
        testing={testing === service.id}
      />)}
    </PanelList> : <EmptyServices apps={apps} />}
    {pending ? <SwitchConfirmDialog onClose={() => setPending(null)} onConfirm={() => void applySwitch(pending)} pending={pending} /> : null}
    {adding || editing ? <AiServiceDialog apps={apps} onClose={() => { setAdding(false); setEditing(null); }} onSaved={saved} service={editing ?? undefined} /> : null}
    {removing ? <RemoveServiceDialog
      busy={busy}
      onClose={() => setRemoving(null)}
      onRemove={() => void removeService(removing)}
      service={removing}
      users={usersOf(removing, apps)}
    /> : null}
  </Panel>;
}
