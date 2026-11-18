import { jsonResponse } from '../../../lib/api';
import type { IconName } from '../../../components/ui';

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
  token: null | { configured: boolean; hint: string | null; verifiedAt: string | null };
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
  const query = new URLSearchParams({ limit: '50' });
  if (clientId) query.set('client', clientId);
  if (before) query.set('before', String(before));
  return request<AiActivityPage>(`/suite-manager/api/ai/activity?${query}`, 'GET', 'Unable to load AI activity.');
}

export type Preset = {
  group: 'home' | 'web';
  icon: IconName;
  id: string;
  label: string;
  meta: string;
  privacy: string;
  routes: AiRoute[];
};

export const PRESETS: Preset[] = [
  { group: 'web', icon: 'globe', id: 'chatgpt', label: 'ChatGPT', meta: 'In your browser and the ChatGPT app.', privacy: 'What ChatGPT reads is sent to OpenAI.', routes: ['tunnel', 'public'] },
  { group: 'web', icon: 'globe', id: 'claude-app', label: 'Claude app', meta: 'In your browser and the Claude app.', privacy: 'What Claude reads is sent to Anthropic.', routes: ['public'] },
  { group: 'home', icon: 'dashboard', id: 'claude-code', label: 'Claude Code', meta: 'On a computer that can reach your suite.', privacy: 'What Claude Code reads goes to your computer, and from there to Anthropic.', routes: ['direct'] },
  { group: 'home', icon: 'dashboard', id: 'gemini-cli', label: 'Gemini CLI', meta: 'On a computer that can reach your suite.', privacy: 'What Gemini CLI reads goes to your computer, and from there to Google.', routes: ['direct'] },
  { group: 'home', icon: 'hard-drive', id: 'local-ai', label: 'An AI you run at home', meta: 'Open WebUI, LM Studio, AnythingLLM and similar.', privacy: 'What it reads stays between your devices.', routes: ['direct'] },
  { group: 'home', icon: 'plus', id: 'other', label: 'Other MCP client', meta: 'Any app that can use MCP. You get an address and a token.', privacy: 'What it reads goes wherever that app sends it.', routes: ['direct'] },
];

export const PRESET_GROUPS: Array<{ id: Preset['group']; title: string }> = [
  { id: 'web', title: 'On the web and your phone' },
  { id: 'home', title: 'On a computer at home' },
];

export function presetOf(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export const ROUTE_WORDS: Record<AiRoute, string> = {
  direct: 'on your home network',
  public: 'through its public address',
  tunnel: 'through OpenAI’s tunnel',
};

export const ROUTE_CHOICES: Record<AiRoute, { icon: IconName; label: string; meta: string }> = {
  direct: { icon: 'network-drive', label: 'On your home network', meta: 'The assistant reaches your suite at its own address.' },
  public: { icon: 'globe', label: 'Straight to your suite', meta: 'The AI company calls your suite’s public address, and you sign in to MOS there.' },
  tunnel: { icon: 'cloud-storage', label: 'Through OpenAI', meta: 'Your suite calls out to OpenAI. Nothing is opened at your home.' },
};

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

export function connectSnippet(presetId: string, mcpUrl: string, token: string): { intro: string; parts: Array<{ label: string; text: string }> } {
  const header = `Authorization: Bearer ${token}`;
  if (presetId === 'claude-code') {
    return { intro: 'Run this once in a terminal on that computer.', parts: [{ label: 'command', text: `claude mcp add --transport http mos ${mcpUrl} --header "${header}"` }] };
  }
  if (presetId === 'gemini-cli') {
    const settings = { mcpServers: { mos: { headers: { Authorization: `Bearer ${token}` }, httpUrl: mcpUrl } } };
    return { intro: 'Add this to mcpServers in Gemini CLI’s settings.json on that computer.', parts: [{ label: 'settings', text: JSON.stringify(settings, null, 2) }] };
  }
  return { intro: 'In the assistant’s MCP settings, add a server with this address and this header.', parts: [{ label: 'address', text: mcpUrl }, { label: 'header', text: header }] };
}
