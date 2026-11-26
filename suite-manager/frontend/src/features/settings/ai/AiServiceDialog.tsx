import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { AiDirectionPicture, DestinationLine, Dialog, Icon, InlineDisclosure, Notice, Select, TextInput, type Place } from '../../../components/ui';
import { AI_IN_APPS_GUIDE_URL } from '../../../lib/links';
import { aiServiceRequest, goToAiCard, nameList, type AiService, type AiServiceApp, type AiServiceCheck, type AiServiceTest, type ServiceChange } from './model';
import { changeRestartLine, hostnameOf, MOVE_CLAUSE, moveLine, originOf, searchLine, testAnswered, testDidNotPass } from './service-words';

type Busy = '' | 'save-restart' | 'save-test' | 'test';
type Helper = { text: ReactNode; tone?: 'error' | 'warning' };

const ADDRESS_PLACE: Record<Place, string> = {
  home: 'On your own network. What your apps send stays at home if the model runs there.',
  internet: 'MOS cannot tell that this is on your own network, so treat it as on the internet.',
  private: 'A private address on your server\'s network.',
};
const SEARCH_HELP = 'For apps that search your content by meaning, such as document chat. Those apps send it the text of everything they keep, to build their search. Leave it empty if you are not sure.';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function addressHelper(checked: AiServiceCheck | null, onTrim: (address: string) => void): Helper {
  if (!checked) return { text: 'Where the service answers. Most addresses end in /v1.' };
  if (checked.advice === 'loopback') return { text: checked.message, tone: 'error' };
  if (checked.advice === 'endpoint' && checked.trimmed) {
    const trimmed = checked.trimmed;
    return { text: <>Use the address up to /v1. MOS and your apps add the rest. <button className="mos-link suite-link-button" onClick={() => onTrim(trimmed)} type="button">Use {trimmed}</button></>, tone: 'warning' };
  }
  if (checked.advice === 'local-name') return { text: 'Use the computer\'s IP address, such as 192.168.1.20. Names ending in .local may not work inside apps.', tone: 'warning' };
  return { text: <DestinationLine variant={checked.place}>{ADDRESS_PLACE[checked.place]}</DestinationLine> };
}

function NoServiceYet() {
  return <InlineDisclosure summary="Do not have one yet?">
    <p className="suite-meta">On a computer of your own, a model program can serve one on your network: turn on its setting that serves on your local network, because many answer only on their own computer until you do. A provider online charges for what your apps send, separately from any chat plan.</p>
    <p><a className="mos-link suite-settings-link" href={`${AI_IN_APPS_GUIDE_URL}#what-you-need`} rel="noreferrer" target="_blank">What you need<Icon name="arrow-right" /></a></p>
  </InlineDisclosure>;
}

// Above every field of Add: the owner who came to the wrong door turns back before the form can scare her.
function AddIntro({ onClose }: { onClose: () => void }) {
  return <>
    <AiDirectionPicture direction="out" size="sm" />
    <p className="suite-meta">This is for an AI service your apps ask. To use your apps from your AI chat, <a className="mos-link" href="#set-ai" onClick={(event) => { event.preventDefault(); onClose(); goToAiCard('set-ai'); }}>add an AI assistant instead.</a></p>
    <p className="suite-meta">An AI service is a model with an address: on a computer of your own, or from a provider that gives you an API key. A ChatGPT or other chat subscription is not one.</p>
    <NoServiceYet />
  </>;
}

function TestResult({ adding, place, tested }: { adding: boolean; place: Place | null; tested: AiServiceTest | null }) {
  if (!tested) return null;
  return tested.ok
    ? <Notice title="The service answered" variant="success"><p>{testAnswered(tested)}</p></Notice>
    : <Notice title="The test did not pass" variant="warning"><p>{testDidNotPass(tested.error ?? '', place, adding)}</p></Notice>;
}

// The apps asking this service would from now on send to another host or another kind of place.
function movesApps(service: AiService, users: AiServiceApp[], baseUrl: string, place: Place) {
  return users.length > 0 && (hostnameOf(baseUrl) !== hostnameOf(service.baseUrl) || place !== service.place);
}

// What a Change starts, said above the button that starts it.
function ChangeConsequences({ baseUrl, embeddingModel, place, service, users }: { baseUrl: string; embeddingModel: string; place: Place; service: AiService; users: AiServiceApp[] }) {
  const host = hostnameOf(baseUrl);
  const restarting = users.filter((app) => app.running).map((app) => app.name);
  const readers = users.filter((app) => app.readsSearchModel).map((app) => app.name);
  const searchAdded = readers.length > 0 && Boolean(embeddingModel) && embeddingModel !== (service.embeddingModel ?? '');
  return <>
    {restarting.length ? <p>{changeRestartLine(restarting)}</p> : null}
    {movesApps(service, users, baseUrl, place) ? <DestinationLine variant={place}>
      <span className="mos-destination-line">{moveLine(users.map((app) => app.name), host)}</span>
      <span className="mos-destination-line">{MOVE_CLAUSE[place]}</span>
    </DestinationLine> : null}
    {searchAdded ? <DestinationLine variant={place}>{searchLine(readers, host)}</DestinationLine> : null}
  </>;
}

function submitLabel(service: AiService | undefined, users: AiServiceApp[], moved: boolean, busy: Busy) {
  if (!service) return busy ? 'Adding…' : 'Add';
  if (busy === 'save-test' || busy === 'save-restart') return 'Saving…';
  if (!users.some((app) => app.running)) return 'Save';
  return moved ? 'Move and restart' : 'Save and restart';
}

// One form for every service, on a computer of the owner's or online: MOS reads which it is from the
// address. Editing keeps the stored key, unless it is retyped or the address moves to another origin.
export function AiServiceDialog({ apps, onClose, onSaved, service }: { apps: AiServiceApp[]; onClose: () => void; onSaved: (saved: ServiceChange) => void; service?: AiService }) {
  const [name, setName] = useState(service?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [model, setModel] = useState(service?.model ?? '');
  const [embeddingModel, setEmbeddingModel] = useState(service?.embeddingModel ?? '');
  const [checked, setChecked] = useState<AiServiceCheck | null>(null);
  const [tested, setTested] = useState<AiServiceTest | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');

  const users = service ? apps.filter((app) => app.serviceId === service.id) : [];
  const newOrigin = Boolean(service) && originOf(baseUrl) !== originOf(service?.baseUrl ?? '');
  const keyHeld = Boolean(service?.keyConfigured) && apiKey === null && !newOrigin;
  const connection = { apiKey: apiKey ?? (keyHeld ? undefined : ''), baseUrl, serviceId: service?.id };
  const place = checked?.place ?? service?.place ?? null;

  async function check(address = baseUrl) {
    if (!address.trim()) return;
    try {
      setChecked(await aiServiceRequest<AiServiceCheck>('POST', '/check', 'The address could not be checked.', { ...connection, baseUrl: address }));
    } catch {
      setChecked(null);
    }
  }

  useEffect(() => { if (service) void check(); }, []);

  function changeAddress(next: string) {
    setBaseUrl(next);
    setChecked(null);
    setTested(null);
  }

  async function test() {
    setBusy('test');
    setError('');
    try {
      setTested({ ...await aiServiceRequest<AiServiceTest>('POST', '/test', 'The service could not be tested.', { ...connection, embeddingModel, model }), ok: true });
    } catch (caught) {
      setTested({ error: errorText(caught, 'The service could not be tested.'), ok: false });
    } finally {
      setBusy('');
    }
  }

  // Saving tests the service once, then restarts the apps that ask it, in that one request.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const fallback = 'The AI service could not be saved.';
    const body = { ...connection, embeddingModel, model, name };
    setError('');
    setBusy(users.some((app) => app.running) ? 'save-restart' : 'save-test');
    try {
      onSaved(await aiServiceRequest<ServiceChange>(service ? 'PUT' : 'POST', service ? `/${service.id}` : '', fallback, body));
    } catch (caught) {
      setError(errorText(caught, fallback));
      setBusy('');
    }
  }

  const models = checked?.models ?? [];
  const listed = (current: string) => (current && !models.includes(current) ? [current, ...models] : models);
  const blocked = checked?.advice === 'loopback';
  const ready = Boolean(name.trim() && baseUrl.trim() && model.trim()) && !blocked;
  const moved = service ? movesApps(service, users, baseUrl, place ?? service.place) : false;
  const address = addressHelper(checked, (trimmed) => { changeAddress(trimmed); void check(trimmed); });
  const who = name.trim() || service?.name || 'the service';
  const status = busy === 'test' || busy === 'save-test' ? `Testing ${who}…` : busy === 'save-restart' ? `Testing ${who}, then restarting ${nameList(users.filter((app) => app.running).map((app) => app.name))}…` : null;

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || blocked || !baseUrl.trim() || !model.trim()} onClick={() => void test()} type="button">Test</button>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !ready} form="suite-ai-service" type="submit">{submitLabel(service, users, moved, busy)}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    status={status}
    title={service ? `Change ${service.name}` : 'Add an AI service'}
  >
    {service ? null : <AddIntro onClose={onClose} />}
    <form className="suite-settings-form" id="suite-ai-service" onSubmit={(event) => void submit(event)}>
      <TextInput autoFocus={!service} helperText="What you call it. Shown wherever an app asks it." label="Name" maxLength={60} onChange={(event) => setName(event.target.value)} value={name} />
      <TextInput autoComplete="off" helperText={address.text} helperTone={address.tone} inputMode="url" label="Address (base URL)" onBlur={() => void check()} onChange={(event) => changeAddress(event.target.value)} placeholder="http://192.168.1.20:1234/v1" spellCheck={false} value={baseUrl} />
      <TextInput
        autoComplete="new-password"
        helperText={newOrigin ? 'Enter the key for this address, if it needs one. MOS never sends the old key to a new address.' : 'Only if the service asks for one. MOS keeps it and never shows it again.'}
        label="API key (optional)"
        onBlur={() => void check()}
        onChange={(event) => { setApiKey(event.target.value); setTested(null); }}
        placeholder={keyHeld ? 'Unchanged' : ''}
        type="password"
        value={apiKey ?? ''}
      />
      {models.length
        ? <Select helperText="The model your apps ask. Listed by the service." label="Model" onChange={(event) => { setModel(event.target.value); setTested(null); }} value={model}>
          <option value="">Choose a model</option>
          {listed(model).map((id) => <option key={id} value={id}>{id}</option>)}
        </Select>
        : <TextInput helperText="The list fills in once the address answers. You can also type the model's ID." label="Model" onChange={(event) => { setModel(event.target.value); setTested(null); }} spellCheck={false} value={model} />}
      {models.length
        ? <Select helperText={SEARCH_HELP} label="Search model (embedding model, optional)" onChange={(event) => { setEmbeddingModel(event.target.value); setTested(null); }} value={embeddingModel}>
          <option value="">None</option>
          {listed(embeddingModel).map((id) => <option key={id} value={id}>{id}</option>)}
        </Select>
        : <TextInput helperText={SEARCH_HELP} label="Search model (embedding model, optional)" onChange={(event) => { setEmbeddingModel(event.target.value); setTested(null); }} spellCheck={false} value={embeddingModel} />}
      <TestResult adding={!service} place={place} tested={tested} />
      {service ? <ChangeConsequences baseUrl={baseUrl} embeddingModel={embeddingModel.trim()} place={place ?? service.place} service={service} users={users} /> : null}
      {error ? <Notice title="The AI service could not be saved" variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}
