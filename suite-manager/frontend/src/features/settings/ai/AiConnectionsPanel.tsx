import { useEffect, useRef, useState } from 'react';

import { Notice, Panel, PanelBody, PanelHead, PanelList } from '../../../components/ui';
import { AddAssistantDialog } from './AddAssistantDialog';
import { ClientItem, NewTokenDialog, RemoveClientDialog, type ClientActions } from './AiParts';
import { aiRequest, levelOf, type AiClient, type AiException, type AiLevel, type AiSource, type AiStatus, type IssuedToken } from './model';

const REFRESH_MS = 15_000;
// While the connect dialog waits for the AI's first contact.
const CONNECT_POLL_MS = 3_000;
const ADDRESS_SETTINGS_PATH = '/suite-manager/settings#set-address';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function clientPath(client: AiClient, rest = '') {
  return `/clients/${encodeURIComponent(client.id)}${rest}`;
}

// Lets the owner's AI use the apps they choose: one level per app per AI, with
// single tools adjusted under Customize.
export function AiConnectionsPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [openClient, setOpenClient] = useState('');
  const [changedClient, setChangedClient] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [addIssued, setAddIssued] = useState<{ clientId: string; token: string } | null>(null);
  const [chatGptAdded, setChatGptAdded] = useState('');
  const [rotated, setRotated] = useState<{ client: AiClient; token: string } | null>(null);
  const [removing, setRemoving] = useState<AiClient | null>(null);
  const loadedOnce = useRef(false);

  // A failed background refresh keeps what is on screen; only a page with nothing loaded yet reports it.
  async function load() {
    try {
      const loaded = await aiRequest('GET', '', 'Unable to load your AI.');
      loadedOnce.current = true;
      setStatus(loaded);
    } catch (caught) {
      if (!loadedOnce.current) setError(errorText(caught, 'Unable to load your AI.'));
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!addIssued && !chatGptAdded) return undefined;
    const timer = window.setInterval(() => void load(), CONNECT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [addIssued, chatGptAdded]);

  async function run(key: string, fallback: string, action: () => Promise<AiStatus>) {
    setBusy(key);
    setError('');
    try {
      setStatus(await action());
      return true;
    } catch (caught) {
      setError(errorText(caught, fallback));
      return false;
    } finally {
      setBusy('');
    }
  }

  async function addClient(name: string) {
    setBusy('add');
    setAddError('');
    try {
      const created = await aiRequest<IssuedToken>('POST', '/clients', 'The AI could not be added.', { name });
      setStatus(created.status);
      if (created.client) setAddIssued({ clientId: created.client.id, token: created.token });
    } catch (caught) {
      setAddError(errorText(caught, 'The AI could not be added.'));
    } finally {
      setBusy('');
    }
  }

  async function connectChatGpt(tunnelId: string, runtimeKey: string) {
    setBusy('add');
    setAddError('');
    try {
      const created = await aiRequest<{ client: AiClient; status: AiStatus }>('POST', '/tunnel', 'ChatGPT could not be connected.', { runtimeKey, tunnelId });
      setStatus(created.status);
      setChatGptAdded(created.client.id);
    } catch (caught) {
      setAddError(errorText(caught, 'ChatGPT could not be connected.'));
    } finally {
      setBusy('');
    }
  }

  function closeAdd() {
    if (addIssued) setOpenClient(addIssued.clientId);
    if (chatGptAdded) setOpenClient(chatGptAdded);
    setAdding(false);
    setAddIssued(null);
    setChatGptAdded('');
  }

  function actionsFor(client: AiClient, sources: AiSource[]): ClientActions {
    const key = `client:${client.id}`;
    const change = async (fallback: string, action: () => Promise<AiStatus>) => {
      if (await run(key, fallback, action)) setChangedClient(client.id);
    };
    return {
      onAccept: (tool) => void change('The tool could not be accepted.', () => aiRequest('POST', `/tools/${encodeURIComponent(tool)}/accept`, 'The tool could not be accepted.')),
      onException: (tool: string, exception: AiException | null) => void change('The tool could not be changed.', () => aiRequest('PUT', clientPath(client, `/exceptions/${encodeURIComponent(tool)}`), 'The tool could not be changed.', { exception })),
      onLevel: (sourceId: string, level: AiLevel) => void change('The setting could not be changed.', () => aiRequest('PUT', clientPath(client, `/levels/${encodeURIComponent(sourceId)}`), 'The setting could not be changed.', { level })),
      onSourceToken: async (sourceId, token) => {
        try {
          setStatus(await aiRequest('PUT', `/sources/${encodeURIComponent(sourceId)}/token`, 'The token could not be saved.', { token }));
          return '';
        } catch (caught) {
          return errorText(caught, 'The token could not be saved.');
        }
      },
      // Apps that follow the default keep what they had: only apps added later take the new default.
      onDefaultLevel: (level) => void run(key, 'The setting could not be changed.', async () => {
        for (const source of sources.filter((candidate) => !client.levels[candidate.id])) {
          await aiRequest('PUT', clientPath(client, `/levels/${encodeURIComponent(source.id)}`), 'The setting could not be changed.', { level: levelOf(client, source.id) });
        }
        return aiRequest('PUT', clientPath(client), 'The setting could not be changed.', { defaultLevel: level });
      }),
      onRemove: () => setRemoving(client),
      onReset: (sourceId) => void change('The tools could not be reset.', () => aiRequest('DELETE', clientPath(client, `/levels/${encodeURIComponent(sourceId)}/exceptions`), 'The tools could not be reset.')),
      onRotate: () => void run(key, 'A new token could not be made.', async () => {
        const issued = await aiRequest<IssuedToken>('POST', clientPath(client, '/token'), 'A new token could not be made.');
        setRotated({ client, token: issued.token });
        return issued.status;
      }),
      onStartTunnel: () => void run(key, 'The tunnel could not be turned on.', () => aiRequest('POST', '/tunnel/start', 'The tunnel could not be turned on.')),
      onToggleEnabled: () => void run(key, 'The AI could not be changed.', () => aiRequest('PUT', clientPath(client), 'The AI could not be changed.', { enabled: !client.enabled })),
    };
  }

  async function removeClient(client: AiClient) {
    if (await run(`client:${client.id}`, 'The AI could not be removed.', () => aiRequest('DELETE', clientPath(client), 'The AI could not be removed.'))) setRemoving(null);
  }

  const sources = status?.sources ?? [];
  const clients = status?.clients ?? [];
  const reachable = Boolean(status?.mcpUrl);
  const issuedClient = clients.find((client) => client.id === addIssued?.clientId);

  return <Panel>
    <PanelHead actions={status ? <button className={`mos-btn ${clients.length ? 'mos-btn-secondary' : 'mos-btn-primary'}`} disabled={Boolean(busy) || !reachable} onClick={() => { setAddError(''); setAdding(true); }} type="button">Add</button> : null} heading="h3" title="AI assistants">
      <p>Use your apps from any AI chat that supports MCP.</p>
    </PanelHead>
    {error ? <PanelBody><Notice title="Something went wrong" variant="error"><p>{error}</p></Notice></PanelBody> : null}
    {clients.length ? <PanelList>
      {clients.map((client) => <ClientItem
        actions={actionsFor(client, sources)}
        busy={busy === `client:${client.id}`}
        changed={changedClient === client.id}
        client={client}
        expanded={openClient === client.id}
        key={client.id}
        onToggle={() => setOpenClient(openClient === client.id ? '' : client.id)}
        sources={sources}
        tunnel={status?.tunnel?.clientId === client.id ? status.tunnel : null}
      />)}
    </PanelList> : status ? <PanelBody>
      {reachable
        ? <p className="suite-meta">No AI is connected yet. Add one to use your apps from your AI chat, such as Claude Code, LM Studio or Open WebUI.</p>
        : <p className="suite-meta">An AI can connect once your suite has an HTTPS address. <a className="mos-link" href={ADDRESS_SETTINGS_PATH}>Set up your suite address</a></p>}
    </PanelBody> : null}
    {adding && status?.mcpUrl ? <AddAssistantDialog busy={busy === 'add'} chatGptAdded={Boolean(chatGptAdded)} connected={Boolean(issuedClient?.lastUsedAt)} error={addError} issued={addIssued?.token ?? null} mcpUrl={status.mcpUrl} onClose={closeAdd} onConnectChatGpt={(tunnelId, runtimeKey) => void connectChatGpt(tunnelId, runtimeKey)} onCreate={(name) => void addClient(name)} onDone={closeAdd} tunnel={status.tunnel} /> : null}
    {rotated && status?.mcpUrl ? <NewTokenDialog client={rotated.client} mcpUrl={status.mcpUrl} onClose={() => setRotated(null)} token={rotated.token} /> : null}
    {removing ? <RemoveClientDialog busy={busy === `client:${removing.id}`} client={removing} onClose={() => setRemoving(null)} onRemove={() => void removeClient(removing)} /> : null}
  </Panel>;
}
