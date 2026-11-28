import type { Place } from '../../../components/ui';
import { jsonResponse } from '../../../lib/api';

export type AiLevel = 'act' | 'off' | 'see';
export type AiException = 'allow' | 'block';
export type AiRoute = 'direct' | 'public' | 'tunnel';
export type OfferedKind = 'add' | 'change' | 'read';

export type AiTool = {
  description: string;
  kind: string;
  name: string;
  note: string | null;
  review: 'changed' | 'new' | 'pinned';
  title: string;
};

export type AiSource = {
  builtin: boolean;
  error: string | null;
  id: string;
  name: string;
  running: boolean;
  // signIn: MOS gets the app's token by signing in with the owner's app password once.
  token: null | { tokenPageUrl: string | null; configured: boolean; hint: string | null; signIn: boolean; verifiedAt: string | null };
  tools: AiTool[];
};

export type AiClient = {
  createdAt: string;
  defaultLevel: AiLevel;
  enabled: boolean;
  exceptions: Record<string, AiException>;
  id: string;
  // The MCP address a direct assistant was given; null for the tunnel and for one MOS never recorded.
  issuedUrl: string | null;
  lastUsedAt: string | null;
  levels: Record<string, AiLevel>;
  name: string;
  preset: string;
  route: AiRoute;
};

export type RouteAvailability = { available: boolean; reason: string | null };

export type TunnelState = 'connected' | 'off' | 'refused' | 'starting';
export type AiTunnel = { clientId: string; state: TunnelState; tunnelId: string };

export type AiStatus = {
  clients: AiClient[];
  mcpUrl: string | null;
  routes: Record<AiRoute, RouteAvailability>;
  sources: AiSource[];
  tunnel: AiTunnel | null;
};

export type IssuedToken = { client?: AiClient; status: AiStatus; token: string };

export type AiOutcome = 'failed' | 'limit-reached' | 'needs-review' | 'never-offered' | 'not-allowed' | 'ok' | 'too-large' | 'tool-error';

export type AiActivityEntry = {
  at: string;
  clientId: string;
  clientName: string;
  clientRemoved: boolean;
  durationMs: number;
  id: number;
  kind: string;
  outcome: AiOutcome;
  repeats: number;
  sourceId: string | null;
  sourceName: string;
  tool: string;
  toolTitle: string;
};

export type AiActivityPage = { entries: AiActivityEntry[]; nextBefore: number | null };
export type AiSummary = { hasActivity: boolean; hasConnections: boolean };

type Method = 'DELETE' | 'GET' | 'POST' | 'PUT';

async function request<T>(url: string, method: Method, fallback: string, body?: unknown): Promise<T> {
  return jsonResponse<T>(await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    method,
  }), fallback);
}

export function aiRequest<T = AiStatus>(method: Method, path: string, fallback: string, body?: unknown): Promise<T> {
  return request<T>(`/suite-manager/api/settings/ai${path}`, method, fallback, body);
}

// A password for an app that signs in once, otherwise a pasted token. Passwords are sent as typed.
export function saveSourceAccess(source: AiSource, secret: string) {
  const path = `/sources/${encodeURIComponent(source.id)}`;
  return source.token?.signIn
    ? aiRequest('POST', `${path}/sign-in`, `MOS could not sign in to ${source.name}.`, { password: secret })
    : aiRequest('PUT', `${path}/token`, 'The token could not be saved.', { token: secret.trim() });
}

export type AiService = {
  baseUrl: string;
  embeddingModel: string | null;
  id: string;
  keyConfigured: boolean;
  model: string;
  name: string;
  place: Place;
  test: { at: string | null; error: string | null };
};

// `variables` are the environment variables the package fills from ${ai.*}, each with the keys it reads.
export type AiServiceApp = {
  aiFeatures: string;
  name: string;
  official: boolean;
  packageId: string;
  readsSearchModel: boolean;
  reviewInvalidated: boolean;
  running: boolean;
  serviceId: string | null;
  variables: Array<{ keys: string[]; name: string }>;
};
export type AiServicesStatus = { apps: AiServiceApp[]; services: AiService[] };
export type AiServiceTest = { error?: string; ms?: number; ok: boolean; searched?: boolean };
export type AddressAdvice = 'endpoint' | 'local-name' | 'loopback';
// message: the sentence for an address MOS refuses, worded once by the backend.
export type AiServiceCheck = { advice: AddressAdvice | null; error: string | null; message: string | null; models: string[]; place: Place; trimmed: string | null };
// Package ids of the apps that did not restart after a change or a remove.
export type ServiceChange = { restartFailures: string[]; status: AiServicesStatus; test?: AiServiceTest };

export function aiServiceRequest<T = AiServicesStatus>(method: Method, path: string, fallback: string, body?: unknown): Promise<T> {
  return request<T>(`/suite-manager/api/settings/ai-services${path}`, method, fallback, body);
}

export function aiSummary() {
  return request<AiSummary>('/suite-manager/api/ai/summary', 'GET', 'Unable to check for AI activity.');
}

export function aiActivity({ before, clientId }: { before?: number | null; clientId?: string }) {
  const query = new URLSearchParams({ limit: '100' });
  if (clientId) query.set('client', clientId);
  if (before) query.set('before', String(before));
  return request<AiActivityPage>(`/suite-manager/api/ai/activity?${query}`, 'GET', 'Unable to load AI activity.');
}

export const LEVEL_OPTIONS: Array<{ label: string; value: AiLevel }> = [
  { label: 'Off', value: 'off' },
  { label: 'See', value: 'see' },
  { label: 'See and do', value: 'act' },
];

export const TUNNEL_WORDS: Record<TunnelState, string> = {
  connected: 'Tunnel connected to OpenAI',
  off: 'Tunnel is off on this server',
  refused: 'OpenAI refused the tunnel',
  starting: 'Tunnel starting',
};

export const LEVEL_WORDS: Record<AiLevel, string> = { act: 'see and do', off: 'off', see: 'see' };

export const KIND_GROUPS: Array<{ kinds: OfferedKind[]; label: string }> = [
  { kinds: ['read'], label: 'Look things up' },
  { kinds: ['add', 'change'], label: 'Make changes' },
];

export function isOffered(tool: AiTool): tool is AiTool & { kind: OfferedKind } {
  return tool.kind === 'read' || tool.kind === 'add' || tool.kind === 'change';
}

export function levelOf(client: AiClient, sourceId: string): AiLevel {
  return client.levels[sourceId] ?? client.defaultLevel;
}

export function levelAllows(level: AiLevel, kind: OfferedKind) {
  return kind === 'read' ? level !== 'off' : level === 'act';
}

export function toolAllowed(client: AiClient, sourceId: string, tool: AiTool & { kind: OfferedKind }) {
  const exception = client.exceptions[tool.name];
  return exception ? exception === 'allow' : levelAllows(levelOf(client, sourceId), tool.kind);
}

export function customizedTools(client: AiClient, source: AiSource) {
  return source.tools.filter((tool) => client.exceptions[tool.name]);
}

export function countOf(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// "Suite Manager, Memos and Paperless-ngx"; past `shown` names, "Suite Manager, Memos, Paperless-ngx and 2 more".
// The one cap on names in a line: past `shown`, the rest are counted.
export function cappedNames(names: string[], shown: number) {
  return names.length > shown ? `${names.slice(0, shown).join(', ')} and ${names.length - shown} more` : names.join(', ');
}

export function nameList(names: string[], shown = 3) {
  if (names.length <= 1) return names.join('');
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return cappedNames(names, shown);
}

export type AiCardAnchor = 'set-ai' | 'set-ai-services';

// The wrong-door link of each add dialog: the hash change makes Settings clear its search and scroll to
// the other card, then focus lands on that card's Add, or on its heading when Add is not there.
export function goToAiCard(anchor: AiCardAnchor) {
  window.history.replaceState(window.history.state, '', `#${anchor}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  const focusCard = () => {
    const card = document.getElementById(anchor);
    const target = card?.querySelector<HTMLElement>('.mos-panel-head-actions .mos-btn:not(:disabled)') ?? card?.querySelector<HTMLElement>('.mos-card-title');
    target?.focus({ preventScroll: true });
  };
  // At once, so the closing dialog finds focus elsewhere and leaves it; again once a cleared search has shown the card.
  focusCard();
  window.requestAnimationFrame(focusCard);
}

export const OUTCOME_WORDS: Record<AiOutcome, string> = {
  failed: 'Failed',
  'limit-reached': 'Refused · 30 an hour reached',
  'needs-review': 'Refused · needs review',
  'never-offered': 'Refused · never offered',
  'not-allowed': 'Refused · not allowed',
  ok: 'Done',
  'too-large': 'Refused · too large',
  'tool-error': 'The app reported an error',
};
