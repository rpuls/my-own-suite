import { useEffect, useState, type FormEvent } from 'react';

import { Dialog, Notice, Select, TextInput } from '../../../components/ui';
import { aiServiceRequest, type AiService, type AiServiceCheck, type AiServicesStatus, type AiServiceTest } from './model';

export type SavedService = { restartFailures?: string[]; status: AiServicesStatus; test: AiServiceTest };

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

export function answeredIn(ms: number | undefined) {
  const seconds = (ms ?? 0) / 1000;
  return `The service answered a test question in ${seconds < 1 ? 'under a second' : `${seconds.toFixed(1)} seconds`}.`;
}

const WHERE = {
  home: 'This address is on your own network. What your apps send stays at home.',
  internet: 'This address is on the internet. What your apps send is read by whoever runs it.',
};

// One form for every service, a model at home or one on the internet: MOS reads
// which it is from the address. Editing leaves the key alone unless it is retyped.
export function AiServiceDialog({ onClose, onSaved, service }: { onClose: () => void; onSaved: (saved: SavedService) => void; service?: AiService }) {
  const [name, setName] = useState(service?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [model, setModel] = useState(service?.model ?? '');
  const [embeddingModel, setEmbeddingModel] = useState(service?.embeddingModel ?? '');
  const [checked, setChecked] = useState<AiServiceCheck | null>(null);
  const [tested, setTested] = useState<AiServiceTest | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const connection = { apiKey: apiKey ?? (service ? undefined : ''), baseUrl, serviceId: service?.id };
  const keyHeld = Boolean(service?.keyConfigured) && apiKey === null;

  async function check() {
    if (!baseUrl.trim()) return;
    try {
      setChecked(await aiServiceRequest<AiServiceCheck>('POST', '/check', 'The address could not be checked.', connection));
    } catch {
      setChecked(null);
    }
  }

  useEffect(() => { if (service) void check(); }, []);

  async function test() {
    setBusy('test');
    setError('');
    try {
      setTested({ ...await aiServiceRequest<{ ms: number }>('POST', '/test', 'The service could not be tested.', { ...connection, model }), ok: true });
    } catch (caught) {
      setTested({ error: errorText(caught, 'The service could not be tested.'), ok: false });
    } finally {
      setBusy('');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError('');
    try {
      const fallback = 'The AI service could not be saved.';
      onSaved(await aiServiceRequest<SavedService>(service ? 'PUT' : 'POST', service ? `/${service.id}` : '', fallback, { ...connection, embeddingModel, model, name }));
    } catch (caught) {
      setError(errorText(caught, 'The AI service could not be saved.'));
      setBusy('');
    }
  }

  const models = checked?.models ?? [];
  const listed = (current: string) => (current && !models.includes(current) ? [current, ...models] : models);
  const ready = Boolean(name.trim() && baseUrl.trim() && model.trim());
  const addressHelp = checked?.error ?? (checked ? WHERE[checked.locality] : 'Where the service answers. Most addresses end in /v1.');

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || !baseUrl.trim() || !model.trim()} onClick={() => void test()} type="button">{busy === 'test' ? 'Testing...' : 'Test'}</button>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !ready} form="suite-ai-service" type="submit">{busy === 'save' ? 'Saving...' : service ? 'Save' : 'Add'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={service ? `Change ${service.name}` : 'Add an AI service'}
  >
    <form className="suite-settings-form" id="suite-ai-service" onSubmit={(event) => void submit(event)}>
      <TextInput autoFocus={!service} helperText="What you want to call it. Shown wherever an app uses it." label="Name" maxLength={60} onChange={(event) => setName(event.target.value)} value={name} />
      <TextInput autoComplete="off" helperText={addressHelp} inputMode="url" label="Address" onBlur={() => void check()} onChange={(event) => { setBaseUrl(event.target.value); setChecked(null); setTested(null); }} placeholder="http://192.168.1.20:1234/v1" spellCheck={false} value={baseUrl} />
      <TextInput autoComplete="new-password" helperText="Leave empty if the service asks for none. MOS keeps it and never shows it again." label="API key (optional)" onBlur={() => void check()} onChange={(event) => { setApiKey(event.target.value); setTested(null); }} placeholder={keyHeld ? 'Unchanged' : ''} type="password" value={apiKey ?? ''} />
      {models.length
        ? <Select helperText="The models this service offers." label="Model" onChange={(event) => { setModel(event.target.value); setTested(null); }} value={model}>
          <option value="">Choose a model</option>
          {listed(model).map((id) => <option key={id} value={id}>{id}</option>)}
        </Select>
        : <TextInput helperText="The list fills in once the address answers. You can also type the model's name." label="Model" onChange={(event) => { setModel(event.target.value); setTested(null); }} spellCheck={false} value={model} />}
      {models.length
        ? <Select helperText="Some apps need a second model to search your content by meaning. Apps that need it say so." label="Search model (optional)" onChange={(event) => setEmbeddingModel(event.target.value)} value={embeddingModel}>
          <option value="">None</option>
          {listed(embeddingModel).map((id) => <option key={id} value={id}>{id}</option>)}
        </Select>
        : <TextInput helperText="Some apps need a second model to search your content by meaning. Apps that need it say so." label="Search model (optional)" onChange={(event) => setEmbeddingModel(event.target.value)} spellCheck={false} value={embeddingModel} />}
      {tested?.ok ? <Notice title="It works" variant="success"><p>{answeredIn(tested.ms)}</p></Notice> : null}
      {tested && !tested.ok ? <Notice title="The test did not pass" variant="warning"><p>{tested.error} You can still add the service.</p></Notice> : null}
      {error ? <Notice title="The AI service could not be saved" variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}
