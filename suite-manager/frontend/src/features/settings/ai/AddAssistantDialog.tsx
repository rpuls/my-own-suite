import { useState, type FormEvent } from 'react';

import { ChoiceRow, Dialog, Icon, Notice, Panel, PanelBand, PanelHead, PanelItem, PanelList, SecretText, TextInput } from '../../../components/ui';
import { TUNNEL_WORDS, type AiTunnel } from './model';

const OPENAI_TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const OPENAI_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';

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

export function TunnelStatus({ tunnel }: { tunnel: AiTunnel | null }) {
  if (!tunnel) return null;
  const note = {
    connected: 'ChatGPT can reach MOS once you add it there.',
    off: 'Turn it on from this AI\'s row.',
    refused: 'Check that the tunnel ID and the key come from the same OpenAI organisation, and that the key has Tunnels: Read and Use.',
    starting: 'This changes by itself in a moment.',
  }[tunnel.state];
  const tone = tunnel.state === 'connected' ? 'accent' : tunnel.state === 'refused' ? 'warning' : 'info';
  return <Panel density="tight"><PanelBand icon={tunnel.state === 'connected' ? 'check' : undefined} layout="row" note={note} title={TUNNEL_WORDS[tunnel.state]} tone={tone} /></Panel>;
}

function ChatGptForm({ busy, error, onBack, onClose, onConnect }: { busy: boolean; error: string; onBack: () => void; onClose: () => void; onConnect: (tunnelId: string, runtimeKey: string) => void }) {
  const [tunnelId, setTunnelId] = useState('');
  const [runtimeKey, setRuntimeKey] = useState('');
  const ready = Boolean(tunnelId.trim() && runtimeKey.trim());

  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready) onConnect(tunnelId.trim(), runtimeKey.trim());
  }

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onBack} type="button">Back</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !ready} form="suite-ai-chatgpt" type="submit">{busy ? 'Connecting...' : 'Connect'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title="Connect ChatGPT"
  >
    <form className="suite-settings-form" id="suite-ai-chatgpt" onSubmit={submit}>
      <p>MOS opens a tunnel out to OpenAI, so nothing at your home is opened to the internet. What ChatGPT reads is sent to OpenAI.</p>
      <ol className="suite-app-guide-steps">
        <li>On the OpenAI platform, <a className="mos-link" href={OPENAI_TUNNELS_URL} rel="noreferrer" target="_blank">create a tunnel<Icon name="external" /></a>.</li>
        <li><a className="mos-link" href={OPENAI_KEYS_URL} rel="noreferrer" target="_blank">Create a key<Icon name="external" /></a>: choose Restricted, and give Tunnels Read and Use.</li>
        <li>Paste both here.</li>
      </ol>
      <TextInput autoFocus label="Tunnel ID" onChange={(event) => setTunnelId(event.target.value)} placeholder="tunnel_..." value={tunnelId} />
      <TextInput autoComplete="new-password" label="Key" onChange={(event) => setRuntimeKey(event.target.value)} type="password" value={runtimeKey} />
      {error ? <Notice title="ChatGPT could not be connected" variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}

function ChatGptNext({ onDone, tunnel }: { onDone: () => void; tunnel: AiTunnel | null }) {
  return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onDone} type="button">Choose apps</button>} onClose={onDone} title="Add MOS in ChatGPT">
    <div className="suite-settings-form">
      <TunnelStatus tunnel={tunnel} />
      <ol className="suite-app-guide-steps">
        <li>In ChatGPT on the web, open Plugins and add a custom MCP server.</li>
        <li>Set Connection to Tunnel, and pick the tunnel you made.</li>
        <li>Set Authentication to No authentication. MOS checks every call itself.</li>
        <li>Choose here which apps ChatGPT may use, then mention the plugin with @ in a chat.</li>
      </ol>
      <p className="suite-meta">ChatGPT keeps its list of tools until you press Refresh tools in the plugin&apos;s settings, so do that after you allow more here.</p>
    </div>
  </Dialog>;
}

function PickKind({ chatGptConnected, onChatGpt, onClose, onOwn }: { chatGptConnected: boolean; onChatGpt: () => void; onClose: () => void; onOwn: () => void }) {
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
        <PanelItem flush quiet={chatGptConnected}>
          <ChoiceRow disabled={chatGptConnected} icon="globe" onPick={onChatGpt}><strong>ChatGPT</strong><span className="suite-meta">{chatGptConnected ? 'Already connected.' : 'MOS reaches OpenAI through a tunnel, so nothing at your home is opened to the internet.'}</span></ChoiceRow>
        </PanelItem>
        <PanelItem flush quiet>
          <ChoiceRow disabled icon="globe" onPick={() => undefined}><strong>Claude app</strong><span className="suite-meta">Coming later. It will need your suite to be reachable from the internet.</span></ChoiceRow>
        </PanelItem>
      </PanelList>
    </Panel>
  </Dialog>;
}

export function AddAssistantDialog({ busy, chatGptAdded, connected, error, issued, mcpUrl, onClose, onConnectChatGpt, onCreate, onDone, tunnel }: {
  busy: boolean;
  chatGptAdded: boolean;
  connected: boolean;
  error: string;
  issued: string | null;
  mcpUrl: string;
  onClose: () => void;
  onConnectChatGpt: (tunnelId: string, runtimeKey: string) => void;
  onCreate: (name: string) => void;
  onDone: () => void;
  tunnel: AiTunnel | null;
}) {
  const [step, setStep] = useState<'chatgpt' | 'own' | 'pick'>('pick');
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
  if (chatGptAdded) return <ChatGptNext onDone={onDone} tunnel={tunnel} />;
  if (step === 'chatgpt') return <ChatGptForm busy={busy} error={error} onBack={() => setStep('pick')} onClose={onClose} onConnect={onConnectChatGpt} />;
  if (step === 'pick') return <PickKind chatGptConnected={Boolean(tunnel)} onChatGpt={() => setStep('chatgpt')} onClose={onClose} onOwn={() => setStep('own')} />;
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
