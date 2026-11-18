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
  token: null | { appUrl: string | null; configured: boolean; hint: string | null; verifiedAt: string | null };
  tools: AiTool[];
};

export type AiClient = {
  createdAt: string;
  defaultLevel: AiLevel;
  enabled: boolean;
  exceptions: Record<string, AiException>;
  id: string;
  lastUsedAt: string | null;
  levels: Record<string, AiLevel>;
  name: string;
  preset: string;
  route: AiRoute;
};

export type RouteAvailability = { available: boolean; reason: string | null };

export type AiStatus = {
  clients: AiClient[];
  mcpUrl: string | null;
  routes: Record<AiRoute, RouteAvailability>;
  sources: AiSource[];
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
