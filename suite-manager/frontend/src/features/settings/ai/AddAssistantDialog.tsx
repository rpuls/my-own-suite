import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';

import { AiDirectionPicture, ChoiceRow, DestinationLine, Dialog, Icon, InlineDisclosure, Notice, Panel, PanelBand, PanelItem, PanelList, SecretText, Spinner, TextInput } from '../../../components/ui';
import { goToAiCard, TUNNEL_WORDS, type AiTunnel } from './model';

const OPENAI_TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const OPENAI_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
export const ADDRESS_SETTINGS_PATH = '/suite-manager/settings#set-address';
const STILL_WAITING_MS = 2 * 60_000;

function setupBlock(mcpUrl: string, token: string) {
  return JSON.stringify({ mcpServers: { mos: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

function LabelledSecret({ label, masked = false, value }: { label: string; masked?: boolean; value: string }) {
  return <div className="suite-ai-secret">
    <span className="suite-field-label">{label}</span>
    <SecretText label={label.toLowerCase()} masked={masked} value={value} />
  </div>;
}

function SetupBlock({ mcpUrl, token }: { mcpUrl: string; token: string }) {
  return <InlineDisclosure summary="Setup block (mcpServers JSON)">
    <SecretText label="setup block" value={setupBlock(mcpUrl, token)} />
    <p className="suite-meta">Some programs use their own format; the address and token above always work.</p>
  </InlineDisclosure>;
}

export function AssistantDestination() {
  return <DestinationLine variant="depends">What it reads goes to whoever runs its AI model, usually an AI company.</DestinationLine>;
}

export function AddressField({ mcpUrl }: { mcpUrl: string }) {
  return <LabelledSecret label="Address (MCP server URL)" value={mcpUrl} />;
}

// The token is shown once, so this is the only moment the owner can copy it.
export function ConnectDetails({ mcpUrl, token }: { mcpUrl: string; token: string }) {
  return <>
    <AddressField mcpUrl={mcpUrl} />
    <LabelledSecret label="Token (bearer)" masked value={token} />
    <div className="suite-ai-secret">
      <span className="suite-field-label">Header (if it asks for one)</span>
      <div className="suite-ai-header-pair">
        <SecretText label="header name" value="Authorization" />
        <SecretText label="header value" masked value={`Bearer ${token}`} />
      </div>
    </div>
    <p className="suite-meta">Copy the token now: it is shown only this once. Anyone with it can use what you allow this assistant, so keep it like a password. You can make a new one from this assistant&apos;s menu.</p>
    <SetupBlock mcpUrl={mcpUrl} token={token} />
  </>;
}

const TUNNEL_NOTES: Record<AiTunnel['state'], string> = {
  connected: 'ChatGPT can reach MOS once you add it there.',
  off: 'Turn it on to let ChatGPT reach your suite from here.',
  refused: 'Check that the tunnel ID and the key come from the same OpenAI organisation, and that the key has Tunnels: Read and Use.',
  starting: 'This changes by itself in a moment.',
};

export function TunnelStatus({ action, tunnel }: { action?: ReactNode; tunnel: AiTunnel }) {
  const tone = tunnel.state === 'connected' ? 'accent' : tunnel.state === 'refused' ? 'warning' : 'info';
  return <Panel density="tight">
    <PanelBand busy={tunnel.state === 'starting'} icon={tunnel.state === 'connected' ? 'check' : undefined} layout="row" note={TUNNEL_NOTES[tunnel.state]} title={TUNNEL_WORDS[tunnel.state]} tone={tone}>{action}</PanelBand>
  </Panel>;
}

// What is left happens in ChatGPT, so the steps are shown wherever ChatGPT has not called yet.
export function ChatGptSteps() {
  return <>
    <p><strong>In ChatGPT on the web:</strong></p>
    <ol className="suite-app-guide-steps">
      <li>Open Settings → Plugins, press +, and choose <strong>Add custom MCP server</strong>.</li>
      <li>Name it MOS.</li>
      <li>Set Connection to <strong>Tunnel</strong>, and pick the tunnel you just created.</li>
      <li>Set Authentication to <strong>No authentication</strong>. It starts on OAuth. The tunnel is the lock, and MOS still checks every call against what you allowed.</li>
      <li>Create it. MOS notices by itself once ChatGPT connects.</li>
    </ol>
  </>;
}

function useStillWaiting(waiting: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setTimeout(() => setSlow(true), STILL_WAITING_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  return slow;
}

// Focus moves to Choose apps only when it was nowhere in particular; otherwise the status names it.
function useReadyFocus(connected: boolean, target: RefObject<HTMLButtonElement | null>) {
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    if (!connected) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.classList.contains('suite-dialog')) target.current?.focus();
    else setAnnounced(true);
  }, [connected, target]);
  return announced;
}

function WaitStatus({ connected, name, readyAnnounced, stillWaiting }: { connected: boolean; name: string; readyAnnounced: boolean; stillWaiting: string | null }) {
  if (connected) {
    return <span className="suite-ai-wait is-connected"><Icon name="check" /><span>{name} is connected.{readyAnnounced ? ' Choose apps is ready.' : ''}</span></span>;
  }
  return <span className="suite-ai-wait"><Spinner /><span>
    <span>Waiting for {name} to connect…</span>
    {stillWaiting ? <span>{stillWaiting}</span> : null}
  </span></span>;
}

function externalLink(href: string, text: string) {
  return <a className="mos-link" href={href} rel="noreferrer" target="_blank">{text}<Icon name="external" /></a>;
}

function ChooseBody({ chatGptAdded, hasAddress, onChatGpt, onClose, onToken }: { chatGptAdded: boolean; hasAddress: boolean; onChatGpt: () => void; onClose: () => void; onToken: () => void }) {
  return <div className="suite-settings-form">
    <div className="suite-ai-door">
      <AiDirectionPicture direction="in" size="sm" />
      <p className="suite-meta">This is for using your apps from your AI chat. For AI features inside your apps, <a className="mos-link" href="#set-ai-services" onClick={(event) => { event.preventDefault(); onClose(); goToAiCard('set-ai-services'); }}>add an AI service instead.</a></p>
    </div>
    <p className="suite-field-label">How does it connect?</p>
    <Panel density="tight">
      <PanelList>
        <PanelItem flush quiet={!hasAddress}>
          <ChoiceRow disabled={!hasAddress} icon="key" onPick={onToken}>
            <strong>With an address and a token</strong>
            <span className="suite-meta">{hasAddress ? 'Coding assistants and desktop chat programs that let you add a server. It reaches your suite\'s HTTPS address.' : 'Needs your suite\'s HTTPS address first.'}</span>
          </ChoiceRow>
        </PanelItem>
        <PanelItem flush quiet={chatGptAdded}>
          <ChoiceRow disabled={chatGptAdded} icon="globe" onPick={onChatGpt}>
            <strong>ChatGPT, through OpenAI&apos;s tunnel</strong>
            <span className="suite-meta">{chatGptAdded ? 'Already added.' : 'Needs an account on the OpenAI platform. Set it up on a computer: the last step is in ChatGPT on the web.'}</span>
          </ChoiceRow>
        </PanelItem>
      </PanelList>
    </Panel>
    {hasAddress ? null : <p><a className="mos-link" href={ADDRESS_SETTINGS_PATH} onClick={onClose}>Set up your suite address<Icon name="arrow-right" /></a></p>}
    <p className="suite-meta">If your AI chat asks you to sign in to add a server, instead of asking for an address and a token, it cannot connect yet. Most AI chats on a phone or tablet cannot.</p>
  </div>;
}

function NameBody({ error, name, onName, onSubmit }: { error: string; name: string; onName: (name: string) => void; onSubmit: () => void }) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }
  return <form className="suite-settings-form" id="suite-ai-connect" onSubmit={submit}>
    <p>Each assistant gets its own token, so you choose what it may use and can turn it off on its own.</p>
    <TextInput autoFocus helperText="So you can tell it apart, name the program and the computer it runs on. You see it here and under AI activity." label="Name" onChange={(event) => onName(event.target.value)} placeholder="LM Studio on my laptop" value={name} />
    {error ? <Notice title="The assistant could not be added" variant="error"><p>{error}</p></Notice> : null}
  </form>;
}

function ChatGptBody({ apiKey, error, onApiKey, onSubmit, onTunnelId, tunnelId }: {
  apiKey: string;
  error: string;
  onApiKey: (value: string) => void;
  onSubmit: () => void;
  onTunnelId: (value: string) => void;
  tunnelId: string;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }
  return <form className="suite-settings-form" id="suite-ai-chatgpt" onSubmit={submit}>
    <p>MOS opens a tunnel out to OpenAI, so nothing new is opened to the internet. What ChatGPT reads is sent to OpenAI.</p>
    <ol className="suite-app-guide-steps">
      <li>On the OpenAI platform, {externalLink(OPENAI_TUNNELS_URL, 'create a tunnel')}.</li>
      <li>{externalLink(OPENAI_KEYS_URL, 'Create an API key')}: choose Restricted, and give Tunnels: Read and Use.</li>
      <li>Paste both here.</li>
    </ol>
    <TextInput autoFocus label="Tunnel ID" onChange={(event) => onTunnelId(event.target.value)} placeholder="tunnel_..." value={tunnelId} />
    <TextInput autoComplete="new-password" helperText="Needs Tunnels: Read and Use." label="API key (restricted)" onChange={(event) => onApiKey(event.target.value)} type="password" value={apiKey} />
    {error ? <Notice title="ChatGPT could not be connected" variant="error"><p>{error}</p></Notice> : null}
  </form>;
}

function ChatGptNextBody({ connected, tunnel }: { connected: boolean; tunnel: AiTunnel | null }) {
  if (connected) return <p>Next, choose which apps ChatGPT may use. In a chat, mention the plugin with @MOS. After you allow more, press Refresh tools in the plugin&apos;s settings.</p>;
  return <div className="suite-settings-form">
    <p>MOS is ready on its side. One step is left, and it happens in ChatGPT.</p>
    {tunnel && tunnel.state !== 'connected' ? <TunnelStatus tunnel={tunnel} /> : null}
    <ChatGptSteps />
  </div>;
}

type View = { body: ReactNode; dismissible?: boolean; footer?: ReactNode; onClose: () => void; title: string };

function button(text: string, onClick: () => void, { disabled = false, kind = 'secondary' }: { disabled?: boolean; kind?: 'ghost' | 'primary' | 'secondary' } = {}) {
  return <button className={`mos-btn mos-btn-${kind}`} disabled={disabled} onClick={onClick} type="button">{text}</button>;
}

function submitButton(text: string, form: string, disabled: boolean) {
  return <button className="mos-btn mos-btn-primary" disabled={disabled} form={form} type="submit">{text}</button>;
}

// One Dialog for the whole flow, so focus goes back to Add when it closes, from whichever step.
// A setup stays open until the assistant has called MOS; stopping it removes the assistant again.
export function AddAssistantDialog({ busy, chatGptAdded, connected, error, issued, mcpUrl, onAbort, onClose, onConnectChatGpt, onCreate, onDone, tunnel }: {
  busy: boolean;
  chatGptAdded: boolean;
  connected: boolean;
  error: string;
  issued: string | null;
  mcpUrl: string | null;
  onAbort: () => void;
  onClose: () => void;
  onConnectChatGpt: (tunnelId: string, apiKey: string) => void;
  onCreate: (name: string) => void;
  onDone: () => void;
  tunnel: AiTunnel | null;
}) {
  const [step, setStep] = useState<'chatgpt' | 'name' | 'pick'>('pick');
  const [name, setName] = useState('');
  const [tunnelId, setTunnelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [leaving, setLeaving] = useState(false);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const waiting = Boolean((issued && mcpUrl) || chatGptAdded);
  const assistant = issued ? name.trim() : 'ChatGPT';
  const slow = useStillWaiting(waiting && !connected);
  const readyAnnounced = useReadyFocus(waiting && connected, chooseRef);
  const ready = Boolean(tunnelId.trim() && apiKey.trim());

  const waitFooter = connected ? <button className="mos-btn mos-btn-primary" onClick={onDone} ref={chooseRef} type="button">Choose apps</button> : undefined;
  const stillWaiting = slow && issued ? `Still waiting? Check that ${assistant} lets you add a server by address and token. Some AI chats cannot.` : null;
  const status = waiting && !leaving ? <WaitStatus connected={connected} name={assistant} readyAnnounced={readyAnnounced} stillWaiting={stillWaiting} /> : null;

  function view(): View {
    if (waiting && leaving && !connected) {
      return {
        body: <p>{assistant} has not connected yet. Stopping removes it from MOS again, and you can add it anew any time.</p>,
        dismissible: false,
        footer: <>{button('Stop and remove', onAbort, { kind: 'ghost' })}{button('Keep setting up', () => setLeaving(false), { kind: 'primary' })}</>,
        onClose: () => setLeaving(false),
        title: `Stop connecting ${assistant}?`,
      };
    }
    const closeWaiting = connected ? onDone : () => setLeaving(true);
    if (issued && mcpUrl) {
      return {
        body: <div className="suite-settings-form">
          <p>In {assistant}, add your suite where it lists MCP servers. Some programs call them connectors, tools or integrations.</p>
          <ConnectDetails mcpUrl={mcpUrl} token={issued} />
          <AssistantDestination />
        </div>,
        dismissible: connected,
        footer: waitFooter,
        onClose: closeWaiting,
        title: `Connect ${assistant}`,
      };
    }
    if (chatGptAdded) {
      return { body: <ChatGptNextBody connected={connected} tunnel={tunnel} />, dismissible: connected, footer: waitFooter, onClose: closeWaiting, title: 'Now add MOS in ChatGPT' };
    }
    const closeUnlessBusy = () => { if (!busy) onClose(); };
    if (step === 'chatgpt') {
      return {
        body: <ChatGptBody apiKey={apiKey} error={error} onApiKey={setApiKey} onSubmit={() => { if (ready) onConnectChatGpt(tunnelId.trim(), apiKey.trim()); }} onTunnelId={setTunnelId} tunnelId={tunnelId} />,
        footer: <>{button('Back', () => setStep('pick'), { disabled: busy })}{submitButton(busy ? 'Connecting...' : 'Connect', 'suite-ai-chatgpt', busy || !ready)}</>,
        onClose: closeUnlessBusy,
        title: 'Connect ChatGPT',
      };
    }
    if (step === 'name') {
      return {
        body: <NameBody error={error} name={name} onName={setName} onSubmit={() => { if (name.trim()) onCreate(name.trim()); }} />,
        footer: <>{button('Back', () => setStep('pick'), { disabled: busy })}{submitButton(busy ? 'Creating...' : 'Create token', 'suite-ai-connect', busy || !name.trim())}</>,
        onClose: closeUnlessBusy,
        title: 'Add an AI assistant',
      };
    }
    return {
      body: <ChooseBody chatGptAdded={Boolean(tunnel)} hasAddress={Boolean(mcpUrl)} onChatGpt={() => setStep('chatgpt')} onClose={onClose} onToken={() => setStep('name')} />,
      onClose,
      title: 'Add an AI assistant',
    };
  }

  const current = view();
  return <Dialog dismissible={current.dismissible ?? true} footer={current.footer} onClose={current.onClose} status={status} title={current.title}>{current.body}</Dialog>;
}
