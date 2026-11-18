import { useState, type FormEvent } from 'react';

import { ChoiceRow, Dialog, Icon, Notice, Panel, PanelBand, PanelHead, PanelItem, PanelList, SecretText, TextInput } from '../../../components/ui';

export function PrivacyLine() {
  return <p className="suite-meta suite-ai-privacy"><Icon name="eye" />If your AI&apos;s model runs in the cloud, what it reads is sent there. Only a model running on your own computer keeps it at home.</p>;
}

function setupBlock(mcpUrl: string, token: string) {
  return JSON.stringify({ mcpServers: { mos: { headers: { Authorization: `Bearer ${token}` }, url: mcpUrl } } }, null, 2);
}

function LabelledSecret({ label, multiline = false, value }: { label: string; multiline?: boolean; value: string }) {
  return <div className={`suite-ai-secret${multiline ? ' is-multiline' : ''}`}>
    <span className="suite-field-label">{label}</span>
    <SecretText label={label.toLowerCase()} value={value} />
  </div>;
}

// The token is shown once, so this is the only moment the owner can copy it.
export function ConnectInstructions({ mcpUrl, token }: { mcpUrl: string; token: string }) {
  return <>
    <p>Add MOS in your AI&apos;s MCP settings. Most AI apps ask for the address and the token. Some, like LM Studio, take the whole setup as one block instead.</p>
    <LabelledSecret label="Address" value={mcpUrl} />
    <LabelledSecret label="Token" value={token} />
    <LabelledSecret label="Setup block (mcp.json)" multiline value={setupBlock(mcpUrl, token)} />
    <p className="suite-meta">If your AI asks for a header, it wants <code>Authorization: Bearer</code> followed by the token. The token is shown only now. If you lose it, make a new one from this AI&apos;s menu.</p>
  </>;
}

function ConnectionStatus({ connected, name }: { connected: boolean; name: string }) {
  return <Panel density="tight">
    {connected
      ? <PanelBand icon="check" layout="row" title={`${name} is connected.`} tone="accent" />
      : <PanelBand layout="row" note="This changes to connected by itself." title={`Waiting for ${name} to connect…`} tone="info" />}
  </Panel>;
}

function PickKind({ onClose, onOwn }: { onClose: () => void; onOwn: () => void }) {
  return <Dialog onClose={onClose} title="Add an AI">
    <Panel density="tight">
      <PanelHead title="On your own network" />
      <PanelList>
        <PanelItem flush>
          <ChoiceRow icon="hard-drive" onPick={onOwn}>
            <strong>Connect your own AI</strong>
            <span className="suite-meta">Use an AI you run yourself, like LM Studio or Open WebUI, so nothing leaves your home. Also works with any external AI that supports MCP, including Claude Code.</span>
          </ChoiceRow>
        </PanelItem>
      </PanelList>
      <PanelHead title="Cloud AI services"><p className="suite-meta">What they read is sent to the company behind them.</p></PanelHead>
      <PanelList>
        <PanelItem flush quiet>
          <ChoiceRow disabled icon="globe" onPick={() => undefined}><strong>ChatGPT</strong><span className="suite-meta">Coming later. MOS will reach OpenAI through its tunnel, so nothing at your home is opened to the internet.</span></ChoiceRow>
        </PanelItem>
        <PanelItem flush quiet>
          <ChoiceRow disabled icon="globe" onPick={() => undefined}><strong>Claude app</strong><span className="suite-meta">Coming later. It will need your suite to be reachable from the internet.</span></ChoiceRow>
        </PanelItem>
      </PanelList>
    </Panel>
  </Dialog>;
}

export function AddAssistantDialog({ busy, connected, error, issued, mcpUrl, onClose, onCreate, onDone }: {
  busy: boolean;
  connected: boolean;
  error: string;
  issued: string | null;
  mcpUrl: string;
  onClose: () => void;
  onCreate: (name: string) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'own' | 'pick'>('pick');
  const [name, setName] = useState('');
  const title = 'Connect your own AI';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim());
  }

  if (issued) {
    return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onDone} type="button">Choose apps</button>} onClose={onDone} title={`Connect ${name.trim()}`}>
      <div className="suite-settings-form">
        <ConnectInstructions mcpUrl={mcpUrl} token={issued} />
        <ConnectionStatus connected={connected} name={name.trim()} />
        <PrivacyLine />
      </div>
    </Dialog>;
  }
  if (step === 'pick') return <PickKind onClose={onClose} onOwn={() => setStep('own')} />;
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => setStep('pick')} type="button">Back</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !name.trim()} form="suite-ai-connect" type="submit">{busy ? 'Creating...' : 'Create token'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={title}
  >
    <form className="suite-settings-form" id="suite-ai-connect" onSubmit={submit}>
      <p>Use an AI you run yourself, like LM Studio or Open WebUI, so nothing leaves your home, or any external AI that supports MCP. Each AI you connect gets its own token, so you choose what it may use and can turn it off on its own.</p>
      <TextInput autoFocus helperText="For example: LM Studio on my laptop." label="Which AI is this?" onChange={(event) => setName(event.target.value)} value={name} />
      {error ? <Notice title="The AI could not be added" variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}
