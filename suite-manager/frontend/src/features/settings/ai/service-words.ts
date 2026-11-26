import type { AdvancedFact, Place } from '../../../components/ui';
import { lowerFirst, shortWhenWords, whenWords } from '../../../lib/dates';
import { cappedNames, nameList, type AiService, type AiServiceApp, type AiServiceTest } from './model';

// What card 2 and its dialogs say, kept apart from how they are laid out. Apps and a
// service "ask"; only the row meta keeps "Used by", the words of the control it sums up.

const META_NAMES = 3;

export function hostnameOf(baseUrl: string) {
  try { return new URL(baseUrl).hostname.replace(/^\[|\]$/gu, ''); } catch { return baseUrl; }
}

export function originOf(baseUrl: string) {
  try { return new URL(baseUrl).origin; } catch { return ''; }
}

export function usersOf(service: AiService, apps: AiServiceApp[]) {
  return apps.filter((app) => app.serviceId === service.id);
}

function namesOf(apps: AiServiceApp[]) {
  return apps.map((app) => app.name);
}

export const HEAD_FIRST_SENTENCE = 'Add an AI service once, then turn it on app by app.';
export const HOOD_LINE = 'an OpenAI-compatible API. Each app gets its address and key when it starts.';

export function headLead(apps: AiServiceApp[]) {
  const list = apps.length ? `Apps with AI features: ${nameList(namesOf(apps))}.` : 'None of your apps has AI features yet.';
  return `${HEAD_FIRST_SENTENCE} ${list}`;
}

// The same words wherever a service is named with its place, in Settings and on an app's page.
export function placeWords(service: AiService) {
  if (service.place === 'home') return 'On your network';
  return service.place === 'private' ? 'Private network' : hostnameOf(service.baseUrl);
}

// How the last test went, in the words card 1 uses for an assistant's last contact.
export function healthWords(service: AiService, checking: boolean) {
  if (checking) return 'Checking…';
  if (!service.test.at) return 'Not tested yet';
  const when = lowerFirst(shortWhenWords(service.test.at));
  return service.test.error ? `Did not answer ${when}` : `Answered ${when}`;
}

export function serviceMeta(service: AiService, apps: AiServiceApp[], checking: boolean) {
  const users = namesOf(usersOf(service, apps));
  return [placeWords(service), users.length ? `Used by ${cappedNames(users, META_NAMES)}` : 'Not used by an app yet', healthWords(service, checking)].join(' · ');
}

export function rowDestination(service: AiService) {
  const host = hostnameOf(service.baseUrl);
  return {
    home: `What these apps send goes to ${host} on your own network, and stays at home as long as the model runs there.`,
    internet: `What these apps send goes to ${host}. Treat it as on the internet: whoever runs it can read it.`,
    private: `What these apps send goes to ${host}, a private address on your server's network.`,
  }[service.place];
}

const SERVING_ON_NETWORK = 'Many model programs answer only on their own computer until you turn on serving on your network.';

export function testFailedTitle(service: AiService) {
  return `${service.name} did not answer when tested ${lowerFirst(whenWords(service.test.at))}`;
}

export function testFailedBody(service: AiService, users: AiServiceApp[]) {
  const online = service.place === 'internet';
  const cannot = users.length ? `If it ${online ? 'still does not answer' : 'is still off'}, ${nameList(namesOf(users))} cannot use AI. ` : '';
  return online
    ? `${cannot}Check the address and the API key, or whether the provider is having trouble.`
    : `${cannot}Check that the computer is on, that its model server is running, and that it accepts connections from other computers. ${SERVING_ON_NETWORK}`;
}

export function testPassedTitle(service: AiService) {
  return `${service.name} answered a test ${lowerFirst(whenWords(service.test.at ?? ''))}`;
}

export function testAnswered(test: AiServiceTest) {
  return test.searched
    ? 'The chat model and the search model both answered a test from your server. Your apps call this same address.'
    : 'The model answered a test question from your server. Your apps call this same address.';
}

export function testDidNotPass(error: string, place: Place | null, adding: boolean) {
  const still = adding ? 'You can still add the service and test it again later.' : 'You can still save the change and test it again later.';
  return [error, still, place && place !== 'internet' ? SERVING_ON_NETWORK : ''].filter(Boolean).join(' ');
}

// The help line under each app's switch, most pressing first. The last line is the package's own
// catalog.aiFeatures sentence, or a generic one when it has none.
export function switchHelp({ app, failed, other, restarting, service }: {
  app: AiServiceApp;
  failed: boolean;
  other: AiService | null;
  restarting: boolean;
  service: AiService;
}): { kind: 'failed' | 'features' | 'other' | 'restarting' | 'stopped'; text: string } {
  if (restarting) return { kind: 'restarting', text: `Restarting ${app.name}…` };
  if (failed) return { kind: 'failed', text: `${app.name} did not restart, so it still uses the old settings until it restarts.` };
  if (!app.running) return { kind: 'stopped', text: app.serviceId === service.id ? `${app.name} is stopped. It asks this service when it next starts.` : `${app.name} is stopped.` };
  if (other) return { kind: 'other', text: `Asks ${other.name} now. Turning it on here moves it.` };
  const redone = app.reviewInvalidated ? ' Its privacy assessment is being redone.' : '';
  return { kind: 'features', text: `${app.aiFeatures || `Turns on ${app.name}'s own AI features.`}${redone}` };
}

export type SwitchKind = 'move' | 'off' | 'on';

export function consentTitle(kind: SwitchKind, app: AiServiceApp, service: AiService) {
  if (kind === 'off') return `Stop ${app.name} asking ${service.name}?`;
  return kind === 'move' ? `Move ${app.name} to ${service.name}?` : `Let ${app.name} ask ${service.name}?`;
}

export function consentFlow(app: AiServiceApp, service: AiService) {
  return `From now on, ${app.name} may send what you keep in it to ${service.name} (${hostnameOf(service.baseUrl)}) for its AI features.`;
}

export const PLACE_CLAUSE: Record<Place, string> = {
  home: 'On your own network: it stays at home as long as the model runs on that computer.',
  internet: 'MOS cannot tell that this is on your own network, so treat it as on the internet: whoever runs it can read what is sent. The provider may charge for each request.',
  private: 'A private address on your server\'s network.',
};

// The clause of a row's destination line as a sentence of its own, for a Change that moves its apps.
export const MOVE_CLAUSE: Record<Place, string> = {
  home: 'It is on your own network, and stays at home as long as the model runs there.',
  internet: 'Treat it as on the internet: whoever runs it can read it.',
  private: 'A private address on your server\'s network.',
};

export function consentAfter(kind: SwitchKind, app: AiServiceApp, service: AiService) {
  const lost = 'For a minute or so it cannot be opened, and anything not yet saved in it is lost.';
  if (kind === 'off') return app.running ? `${app.name} restarts without its AI features. ${lost}` : `${app.name} is stopped. It starts without its AI features the next time it starts.`;
  return app.running ? `${app.name} restarts to pick it up. ${lost}` : `${app.name} is stopped. It starts asking ${service.name} the next time it starts.`;
}

export function consentButton(kind: SwitchKind, running: boolean) {
  const verb = { move: 'Move', off: 'Turn off', on: 'Turn on' }[kind];
  return running ? `${verb} and restart` : verb;
}

export function changeRestartLine(names: string[]) {
  return names.length === 1
    ? `${names[0]} restarts to pick up the change. For a minute or so it cannot be opened, and anything not yet saved in it is lost.`
    : `${nameList(names)} restart to pick up the change. For a minute or so they cannot be opened, and anything not yet saved in them is lost.`;
}

export function moveLine(names: string[], host: string) {
  return names.length === 1
    ? `From now on, ${names[0]} sends what it works on to ${host}.`
    : `From now on, ${nameList(names)} send what they work on to ${host}.`;
}

export function searchLine(names: string[], host: string) {
  return names.length === 1
    ? `From now on, ${names[0]} sends the text of everything it keeps to ${host} in the background, to build its search.`
    : `From now on, ${nameList(names)} send the text of everything they keep to ${host} in the background, to build their search.`;
}

export function removeBody(users: AiServiceApp[]) {
  if (!users.length) return 'MOS forgets this service and its key.';
  const one = users.length === 1;
  return `MOS forgets this service and its key. ${nameList(namesOf(users))} ${one ? 'loses its' : 'lose their'} AI features and ${one ? 'restarts' : 'restart'}.`;
}

export function notRestartedAfterRemove(names: string[], service: string) {
  return names.length === 1
    ? { body: `It may still ask ${service} until it restarts.`, link: 'Restart it from its page', title: `${names[0]} did not restart` }
    : { body: `They may still ask ${service} until they restart.`, link: 'Restart them from their pages', title: `${nameList(names)} did not restart` };
}

function variableWords({ keys, name }: AiServiceApp['variables'][number]) {
  if (keys.includes('apiKey')) return `${name} (environment variable, only with a key)`;
  return keys.some((key) => key.startsWith('embedding')) ? `${name} (only with a search model)` : name;
}

function lastTest(service: AiService) {
  if (!service.test.at) return 'Not tested yet';
  return `${lowerFirst(whenWords(service.test.at))} · ${service.test.error ? 'did not answer' : 'answered'}`;
}

// What a running app actually receives: MOS leaves out a variable whose ${ai.*} value is empty.
export function connectionFacts(service: AiService, users: AiServiceApp[]): AdvancedFact[] {
  return [
    { code: true, label: 'Base URL', value: service.baseUrl },
    { code: true, label: 'Chat completions', value: `${service.baseUrl}/chat/completions` },
    { code: true, label: 'Model', value: service.model },
    { code: Boolean(service.embeddingModel), label: 'Search model', value: service.embeddingModel ?? 'none' },
    { label: 'API key', value: service.keyConfigured ? 'saved, never shown' : 'none' },
    ...users.map((app) => ({ label: `${app.name} gets`, value: app.variables.map(variableWords).join(', ') })),
    { label: 'Last test', value: lastTest(service) },
  ];
}
