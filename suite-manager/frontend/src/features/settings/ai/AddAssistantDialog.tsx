import { useState, type FormEvent } from 'react';

import { Dialog, Icon, Notice, SecretText, TextInput } from '../../../components/ui';

export function PrivacyLine() {
  return <p className="suite-meta suite-ai-privacy"><Icon name="eye" />What your AI reads goes wherever that AI sends it. An AI that runs on your own computer keeps it at home.</p>;
}

// The token is shown once, so this is the only moment the owner can copy it.
export function ConnectInstructions({ mcpUrl, token }: { mcpUrl: string | null; token: string }) {
  if (!mcpUrl) {
    return <>
      <SecretText label="token" value={token} />
      <p className="suite-meta">Your suite needs an HTTPS address before an AI can reach it.</p>
    </>;
  }
  return <>
    <p>In your AI&apos;s MCP settings, add a server with this address and token.</p>
    <SecretText label="address" value={mcpUrl} />
    <SecretText label="token" value={token} />
    <p className="suite-meta">Apps that ask for a header want <code>Authorization: Bearer</code> followed by the token. The token is shown only now. If you lose it, make a new one from the connection&apos;s menu.</p>
  </>;
}

export function AddAssistantDialog({ busy, error, issued, mcpUrl, onClose, onCreate, onDone }: {
  busy: boolean;
  error: string;
  issued: string | null;
  mcpUrl: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const title = 'Connect your AI to MOS';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim());
  }

  if (issued) {
    return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onDone} type="button">Choose apps</button>} onClose={onDone} title={`Connect ${name.trim()}`}>
      <div className="suite-settings-form">
        <ConnectInstructions mcpUrl={mcpUrl} token={issued} />
        <PrivacyLine />
      </div>
    </Dialog>;
  }
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !name.trim()} form="suite-ai-connect" type="submit">{busy ? 'Creating...' : 'Create token'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={title}
  >
    <form className="suite-settings-form" id="suite-ai-connect" onSubmit={submit}>
      <p>Use your apps from any AI chat that supports MCP, such as Claude Code, LM Studio or Open WebUI. Each AI you connect gets its own token, so you choose what it may use and can turn it off on its own.</p>
      <TextInput autoFocus helperText="For example: LM Studio on my laptop." label="Which AI is this?" onChange={(event) => setName(event.target.value)} value={name} />
      {error ? <Notice title="The connection could not be added" variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}
