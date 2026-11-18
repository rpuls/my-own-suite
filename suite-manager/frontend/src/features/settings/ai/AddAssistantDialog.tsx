import { Fragment, useState, type FormEvent } from 'react';

import { ChoiceRow, Dialog, Icon, Notice, Panel, PanelHead, PanelItem, PanelList, SecretText, TextInput } from '../../../components/ui';
import { connectSnippet, PRESET_GROUPS, PRESETS, ROUTE_CHOICES, ROUTE_WORDS, type AiRoute, type AiStatus, type Preset } from './model';

type Step = { name: 'pick' } | { name: 'route'; preset: Preset } | { name: 'connect'; preset: Preset; route: AiRoute };

export function PrivacyLine({ preset }: { preset: Preset }) {
  return <p className="suite-meta suite-ai-privacy"><Icon name="eye" />{preset.privacy}</p>;
}

function DialogHeading({ subtitle, title }: { subtitle: string; title: string }) {
  return <div><h2>{title}</h2><p className="suite-meta">{subtitle}</p></div>;
}

function capitalized(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The token is shown once, so this is the only moment the owner can copy it.
export function ConnectInstructions({ mcpUrl, preset, token }: { mcpUrl: string | null; preset: Preset; token: string }) {
  if (!mcpUrl) {
    return <>
      <SecretText label="token" value={token} />
      <p className="suite-meta">Your suite needs an HTTPS address before an assistant can reach it.</p>
    </>;
  }
  const snippet = connectSnippet(preset.id, mcpUrl, token);
  return <>
    <p>{snippet.intro}</p>
    {snippet.parts.map((part) => <SecretText key={part.label} label={part.label} value={part.text} />)}
    <p className="suite-meta">The token is shown only now. If you lose it, make a new one from the assistant&apos;s menu.</p>
  </>;
}

function presetBlocker(preset: Preset, routes: AiStatus['routes']) {
  if (preset.routes.some((route) => routes[route].available)) return null;
  return routes[preset.routes[0]!].reason || 'Not available yet.';
}

function PickAssistant({ onClose, onPick, routes }: { onClose: () => void; onPick: (preset: Preset) => void; routes: AiStatus['routes'] }) {
  return <Dialog onClose={onClose} title="Add an assistant">
    <Panel density="tight">
      {PRESET_GROUPS.map((group) => <Fragment key={group.id}>
        <PanelHead title={group.title} />
        <PanelList>
          {PRESETS.filter((preset) => preset.group === group.id).map((preset) => {
            const blocker = presetBlocker(preset, routes);
            return <PanelItem flush key={preset.id} quiet={Boolean(blocker)}>
              <ChoiceRow disabled={Boolean(blocker)} icon={preset.icon} onPick={() => onPick(preset)}>
                <strong>{preset.label}</strong><span className="suite-meta">{blocker ?? preset.meta}</span>
              </ChoiceRow>
            </PanelItem>;
          })}
        </PanelList>
      </Fragment>)}
    </Panel>
  </Dialog>;
}

function PickRoute({ onBack, onClose, onContinue, preset, routes }: {
  onBack: () => void;
  onClose: () => void;
  onContinue: (route: AiRoute) => void;
  preset: Preset;
  routes: AiStatus['routes'];
}) {
  const [chosen, setChosen] = useState<AiRoute | undefined>(preset.routes.find((route) => routes[route].available));
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" onClick={onBack} type="button">Back</button>
      <button className="mos-btn mos-btn-primary" disabled={!chosen} onClick={() => { if (chosen) onContinue(chosen); }} type="button">Continue</button>
    </>}
    onClose={onClose}
    title={`How should ${preset.label} reach your suite?`}
  >
    <Panel density="tight">
      <PanelList>
        {preset.routes.map((route) => {
          const { available, reason } = routes[route];
          const choice = ROUTE_CHOICES[route];
          return <PanelItem flush key={route} quiet={!available} selected={chosen === route}>
            <ChoiceRow disabled={!available} icon={choice.icon} radio={{ checked: chosen === route, name: 'suite-ai-route', onChange: () => setChosen(route), value: route }}>
              <strong>{choice.label}</strong><span className="suite-meta">{available ? choice.meta : `Not available: ${reason || 'not built yet.'}`}</span>
            </ChoiceRow>
          </PanelItem>;
        })}
      </PanelList>
    </Panel>
  </Dialog>;
}

function ConnectDirect({ busy, error, issued, mcpUrl, onBack, onClose, onCreate, onDone, preset }: {
  busy: boolean;
  error: string;
  issued: string | null;
  mcpUrl: string | null;
  onBack: () => void;
  onClose: () => void;
  onCreate: (name: string) => void;
  onDone: () => void;
  preset: Preset;
}) {
  const [name, setName] = useState(preset.label);
  const title = `Connect ${preset.label}`;
  const header = <DialogHeading subtitle={capitalized(ROUTE_WORDS.direct)} title={title} />;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim());
  }

  if (issued) {
    return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onDone} type="button">Choose apps</button>} header={header} onClose={onDone} title={title}>
      <div className="suite-settings-form">
        <ConnectInstructions mcpUrl={mcpUrl} preset={preset} token={issued} />
        <PrivacyLine preset={preset} />
      </div>
    </Dialog>;
  }
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onBack} type="button">Back</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !name.trim()} form="suite-ai-connect" type="submit">{busy ? 'Creating...' : 'Create token'}</button>
    </>}
    header={header}
    onClose={() => { if (!busy) onClose(); }}
    title={title}
  >
    <form className="suite-settings-form" id="suite-ai-connect" onSubmit={submit}>
      <TextInput autoFocus helperText="So you can tell your assistants apart." label="Name" onChange={(event) => setName(event.target.value)} value={name} />
      {mcpUrl ? <p className="suite-meta">It will connect to <code>{mcpUrl}</code>.</p> : null}
      {error ? <Notice title="The assistant could not be added" variant="error"><p>{error}</p></Notice> : null}
    </form>
    <PrivacyLine preset={preset} />
  </Dialog>;
}

// One dialog walks the owner from "which AI" to a working connection. A preset
// with a single route skips the route question; each route brings its own body.
export function AddAssistantDialog({ busy, error, issued, onClose, onCreate, onDone, status }: {
  busy: boolean;
  error: string;
  issued: string | null;
  onClose: () => void;
  onCreate: (input: { name: string; preset: string; route: AiRoute }) => void;
  onDone: () => void;
  status: AiStatus;
}) {
  const [step, setStep] = useState<Step>({ name: 'pick' });

  function pick(preset: Preset) {
    const available = preset.routes.filter((route) => status.routes[route].available);
    if (preset.routes.length > 1) setStep({ name: 'route', preset });
    else if (available[0]) setStep({ name: 'connect', preset, route: available[0] });
  }

  if (step.name === 'pick') return <PickAssistant onClose={onClose} onPick={pick} routes={status.routes} />;
  if (step.name === 'route') {
    return <PickRoute onBack={() => setStep({ name: 'pick' })} onClose={onClose} onContinue={(route) => setStep({ name: 'connect', preset: step.preset, route })} preset={step.preset} routes={status.routes} />;
  }
  const back = () => (step.preset.routes.length > 1 ? setStep({ name: 'route', preset: step.preset }) : setStep({ name: 'pick' }));
  if (step.route !== 'direct') {
    return <Dialog footer={<button className="mos-btn mos-btn-secondary" onClick={back} type="button">Back</button>} onClose={onClose} title={`Connect ${step.preset.label}`}>
      <p>This version of Suite Manager cannot connect an assistant {ROUTE_WORDS[step.route]} yet.</p>
    </Dialog>;
  }
  return <ConnectDirect
    busy={busy}
    error={error}
    issued={issued}
    mcpUrl={status.mcpUrl}
    onBack={back}
    onClose={onClose}
    onCreate={(name) => onCreate({ name, preset: step.preset.id, route: step.route })}
    onDone={onDone}
    preset={step.preset}
  />;
}
