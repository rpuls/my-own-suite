import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AiDirectionPicture, Icon, Panel, PanelBand, PanelBody, PanelHead, PanelHeadButton, PanelHeadHood, PanelList, PendingLine, PendingRow } from '../../../components/ui';
import { AI_ASSISTANTS_GUIDE_URL } from '../../../lib/links';
import { navigateOnClick } from '../../../lib/navigation';
import { ADDRESS_SETTINGS_PATH, AddAssistantDialog } from './AddAssistantDialog';
import { ClientItem, NewTokenDialog, RemoveClientDialog, type ClientActions, type FailureSpot } from './AiParts';
import { examplePrompts, headLead } from './assistant-words';
import { aiRequest, levelOf, nameList, saveSourceAccess, type AiClient, type AiException, type AiLevel, type AiSource, type AiStatus, type IssuedToken } from './model';

const REFRESH_MS = 15_000;
// While the connect dialog waits for the assistant's first contact.
const CONNECT_POLL_MS = 3_000;
const AI_ACTIVITY_PATH = '/suite-manager/ai-activity';
const LEAD_FIRST_SENTENCE = 'Ask your AI chat to look things up or make changes for you.';

type Failure = { clientId: string; message: string; spot: FailureSpot | 'remove' };

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function clientPath(client: AiClient, rest = '') {
  return `/clients/${encodeURIComponent(client.id)}${rest}`;
}

function AssistantsHead({ actions, hood, lead }: { actions?: ReactNode; hood: ReactNode; lead: ReactNode }) {
  return <PanelHead actions={actions} figure={<AiDirectionPicture direction="in" size="md" />} heading="h3" title="AI assistants">
    {lead}
    {hood}
  </PanelHead>;
}

const HOOD_LINE = <PanelHeadHood>your suite is an MCP server, and each assistant gets its own token.</PanelHeadHood>;

function PendingAssistants() {
  return <Panel className="mos-pending">
    <AssistantsHead hood={<PendingLine width="80%" />} lead={<><PendingLine width="95%" /><PendingLine width="55%" /></>} />
    <PanelList>
      <PendingRow lead="avatar" meta="60%" name="30%" />
      <PendingRow lead="avatar" meta="45%" name="24%" />
    </PanelList>
  </Panel>;
}

function UnloadedAssistants({ onRetry }: { onRetry: () => void }) {
  return <Panel>
    <AssistantsHead hood={HOOD_LINE} lead={<p>{LEAD_FIRST_SENTENCE}</p>} />
    <PanelBand icon="alert" layout="row" note="It tries again by itself." title="Could not load this." tone="warning">
      <button className="mos-btn mos-btn-secondary" onClick={onRetry} type="button">Try again</button>
    </PanelBand>
  </Panel>;
}

const SET_UP_ADDRESS = <a className="mos-link" href={ADDRESS_SETTINGS_PATH}>Set up your suite address<Icon name="arrow-right" /></a>;

// The tunnel reaches the MCP server on loopback, so only direct assistants need the HTTPS address.
function NoAddressBand({ clients }: { clients: AiClient[] }) {
  const direct = clients.filter((client) => client.route === 'direct').map((client) => client.name);
  if (direct.length) {
    return <PanelBand icon="alert" layout="row" note="ChatGPT is not affected." title={`Your suite has no HTTPS address now, so ${nameList(direct)} cannot reach it.`} tone="warning">{SET_UP_ADDRESS}</PanelBand>;
  }
  return <PanelBand icon="info" layout="row" note="ChatGPT works without one." title="Most AI assistants reach your suite at its HTTPS address, and your suite does not have one yet." tone="info">{SET_UP_ADDRESS}</PanelBand>;
}

function NoAssistantYet({ sources }: { sources: AiSource[] }) {
  return <PanelBody>
    <p className="suite-meta">
      No assistant yet. You need an AI program on a computer that lets you add a server by address and token, or ChatGPT. Then ask it things like {examplePrompts(sources)}{' '}
      <a className="mos-link" href={AI_ASSISTANTS_GUIDE_URL} rel="noreferrer" target="_blank">How it works<Icon name="arrow-right" /></a>
    </p>
  </PanelBody>;
}

function WhereReadsGo({ withActivity }: { withActivity: boolean }) {
  return <PanelBand
    icon="info"
    layout="row"
    note="Only a model that runs on a computer of your own keeps it off any AI company's servers."
    title="What an assistant reads goes to whoever runs its AI model: usually an AI company, even when the program is installed on your computer."
  >
    {withActivity ? <a className="mos-link" href={AI_ACTIVITY_PATH} onClick={navigateOnClick(AI_ACTIVITY_PATH)}>AI activity<Icon name="arrow-right" /></a> : null}
  </PanelBand>;
}

// Lets the owner's AI chat use the apps they allow: one level per app per assistant, with
// single tools adjusted under Customize.
export function AiConnectionsPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
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

  // A failed background refresh keeps what is on screen; only a card with nothing loaded yet reports it.
  async function load() {
    try {
      const loaded = await aiRequest('GET', '', 'Unable to load your assistants.');
      loadedOnce.current = true;
      setLoadFailed(false);
      setStatus(loaded);
    } catch {
      if (!loadedOnce.current) setLoadFailed(true);
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

  async function run(client: AiClient, spot: Failure['spot'], fallback: string, action: () => Promise<AiStatus>) {
    setBusy(`client:${client.id}`);
    setFailure(null);
    try {
      setStatus(await action());
      return true;
    } catch (caught) {
      setFailure({ clientId: client.id, message: errorText(caught, fallback), spot });
      return false;
    } finally {
      setBusy('');
    }
  }

  async function addClient(name: string) {
    setBusy('add');
    setAddError('');
    try {
      const created = await aiRequest<IssuedToken>('POST', '/clients', 'The assistant could not be added.', { name });
      setStatus(created.status);
      if (created.client) setAddIssued({ clientId: created.client.id, token: created.token });
    } catch (caught) {
      setAddError(errorText(caught, 'The assistant could not be added.'));
    } finally {
      setBusy('');
    }
  }

  async function connectChatGpt(tunnelId: string, apiKey: string) {
    setBusy('add');
    setAddError('');
    try {
      const created = await aiRequest<{ client: AiClient; status: AiStatus }>('POST', '/tunnel', 'ChatGPT could not be connected.', { runtimeKey: apiKey, tunnelId });
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

  async function abortAdd() {
    const pending = addIssued?.clientId ?? chatGptAdded;
    setAdding(false);
    setAddIssued(null);
    setChatGptAdded('');
    if (!pending) return;
    setBusy(`client:${pending}`);
    try {
      setStatus(await aiRequest('DELETE', `/clients/${encodeURIComponent(pending)}`, 'The assistant could not be removed.'));
    } catch {
      void load();
    } finally {
      setBusy('');
    }
  }

  function actionsFor(client: AiClient, sources: AiSource[]): ClientActions {
    const change = async (spot: FailureSpot, fallback: string, action: () => Promise<AiStatus>) => {
      if (await run(client, spot, fallback, action)) setChangedClient(client.id);
    };
    const levelPath = (sourceId: string, rest = '') => clientPath(client, `/levels/${encodeURIComponent(sourceId)}${rest}`);
    return {
      onAccept: (sourceId, tool) => void change(`tools:${sourceId}`, 'The tool could not be accepted.', () => aiRequest('POST', `/tools/${encodeURIComponent(tool)}/accept`, 'The tool could not be accepted.')),
      onException: (sourceId, tool, exception: AiException | null) => void change(`tools:${sourceId}`, 'The tool could not be changed.', () => aiRequest('PUT', clientPath(client, `/exceptions/${encodeURIComponent(tool)}`), 'The tool could not be changed.', { exception })),
      onLevel: (sourceId: string, level: AiLevel) => void change(`level:${sourceId}`, 'The setting could not be changed.', () => aiRequest('PUT', levelPath(sourceId), 'The setting could not be changed.', { level })),
      onSourceToken: async (sourceId, secret) => {
        const source = sources.find((candidate) => candidate.id === sourceId);
        if (!source) return 'That app is no longer installed.';
        try {
          setStatus(await saveSourceAccess(source, secret));
          return '';
        } catch (caught) {
          return errorText(caught, 'MOS could not connect to the app.');
        }
      },
      // Apps that follow the default keep what they had: only apps installed later take the new default.
      onDefaultLevel: (level) => void run(client, 'row', 'The setting could not be changed.', async () => {
        for (const source of sources.filter((candidate) => !client.levels[candidate.id])) {
          await aiRequest('PUT', levelPath(source.id), 'The setting could not be changed.', { level: levelOf(client, source.id) });
        }
        return aiRequest('PUT', clientPath(client), 'The setting could not be changed.', { defaultLevel: level });
      }),
      onRemove: () => { setFailure(null); setRemoving(client); },
      onReset: (sourceId) => void change(`tools:${sourceId}`, 'The tools could not be reset.', () => aiRequest('DELETE', levelPath(sourceId, '/exceptions'), 'The tools could not be reset.')),
      onRotate: () => void run(client, 'row', 'A new token could not be made.', async () => {
        const issued = await aiRequest<IssuedToken>('POST', clientPath(client, '/token'), 'A new token could not be made.');
        setRotated({ client, token: issued.token });
        return issued.status;
      }),
      onStartTunnel: () => void run(client, 'row', 'The tunnel could not be turned on.', () => aiRequest('POST', '/tunnel/start', 'The tunnel could not be turned on.')),
      onToggleEnabled: () => void run(client, 'row', 'The assistant could not be changed.', () => aiRequest('PUT', clientPath(client), 'The assistant could not be changed.', { enabled: !client.enabled })),
    };
  }

  async function removeClient(client: AiClient) {
    if (await run(client, 'remove', 'The assistant could not be removed.', () => aiRequest('DELETE', clientPath(client), 'The assistant could not be removed.'))) setRemoving(null);
  }

  if (!status) return loadFailed ? <UnloadedAssistants onRetry={() => void load()} /> : <PendingAssistants />;

  const { clients, mcpUrl, sources, tunnel } = status;
  const failuresOf = (client: AiClient) => (failure?.clientId === client.id ? { [failure.spot]: failure.message } : {});
  const issuedClient = clients.find((client) => client.id === (addIssued?.clientId ?? chatGptAdded));
  const add = <PanelHeadButton accessibleLabel="Add an AI assistant" disabled={Boolean(busy) || (!mcpUrl && Boolean(tunnel))} onClick={() => { setAddError(''); setAdding(true); }}>Add</PanelHeadButton>;

  return <Panel className="mos-arrive">
    <AssistantsHead actions={add} hood={HOOD_LINE} lead={<p>{headLead(sources)}</p>} />
    {mcpUrl ? null : <NoAddressBand clients={clients} />}
    {clients.length ? <PanelList>
      {clients.map((client) => <ClientItem
        actions={actionsFor(client, sources)}
        busy={busy === `client:${client.id}`}
        changed={changedClient === client.id}
        client={client}
        expanded={openClient === client.id}
        failures={failuresOf(client)}
        key={client.id}
        mcpUrl={mcpUrl}
        onToggle={() => setOpenClient(openClient === client.id ? '' : client.id)}
        sources={sources}
        tunnel={tunnel?.clientId === client.id ? tunnel : null}
      />)}
    </PanelList> : <NoAssistantYet sources={sources} />}
    <WhereReadsGo withActivity={clients.length > 0} />
    {adding ? <AddAssistantDialog busy={busy === 'add'} chatGptAdded={Boolean(chatGptAdded)} connected={Boolean(issuedClient?.lastUsedAt)} error={addError} issued={addIssued?.token ?? null} mcpUrl={mcpUrl} onAbort={() => void abortAdd()} onClose={closeAdd} onConnectChatGpt={(tunnelId, apiKey) => void connectChatGpt(tunnelId, apiKey)} onCreate={(name) => void addClient(name)} onDone={closeAdd} tunnel={tunnel} /> : null}
    {rotated && mcpUrl ? <NewTokenDialog client={rotated.client} mcpUrl={mcpUrl} onClose={() => setRotated(null)} token={rotated.token} /> : null}
    {removing ? <RemoveClientDialog busy={busy === `client:${removing.id}`} client={removing} error={failure?.clientId === removing.id && failure.spot === 'remove' ? failure.message : ''} onClose={() => setRemoving(null)} onRemove={() => void removeClient(removing)} /> : null}
  </Panel>;
}
