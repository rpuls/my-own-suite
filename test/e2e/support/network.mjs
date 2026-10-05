// The capture behind the `network` step: what each app's containers look up and connect
// to off the lab, and which hosts outside the suite its pages ask for, held against what
// the app's privacy review says it may contact.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { catalogApps } from './catalog.mjs';
import { repoRoot } from './env.mjs';

export const CONTROL_HOST = 'example.com';
const APP_CONTAINER = 'mos-app-';
const LOCAL_SUFFIXES = ['.arpa', '.internal', '.lan', '.local', '.localdomain'];
// A container's first packets can reach the capture before its start line does.
const START_SLACK_S = 5;
// A container being stopped loses its network while its control still runs.
const CONTROL_LIFETIME_S = 2;
const APP_STEPS = new Set(['app', 'verify']);
const script = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'netcap.sh'), 'utf8').replaceAll('\r', '');

const PACKET = /^(\d+\.\d+) (?:(\S+) +\S+ +)?IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+): (.*)$/u;
const QUERY = /^(\d+)\+?(?: \[[^\]]*\])? [A-Z0-9]+\? (\S+) \(/u;
const ANSWER = /^(\d+)\S* (?:[A-Za-z]+ )?\d+\/\d+\/\d+(?: \[[^\]]*\])?(.*)$/u;

const now = () => Date.now() / 1000;
const hostName = (value) => String(value).toLowerCase().replace(/\.$/u, '');

export function suiteBase(url) {
  const { hostname } = new URL(url);
  return hostname.startsWith('home.') ? hostname.slice(5) : hostname;
}

function underAny(host, domains) {
  return [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function sshArgs({ key, target }, knownHosts) {
  return [
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    // A lab gets a new host key with every rebuild, so one is trusted for one run.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHosts.replaceAll('\\', '/')}`,
    target,
  ];
}

function startServerCapture(shell, dir) {
  if (!shell) {
    return { reason: 'there is no root shell on the lab. Rebuild the Hyper-V lab (npm run smoke:hyperv:reset bakes in a key), or set MOS_E2E_LAB_SSH and MOS_E2E_LAB_SSH_KEY.', status: 'off' };
  }
  const log = fs.createWriteStream(path.join(dir, 'server.log'));
  const [program, args] = shell.target === 'local'
    ? ['sudo', ['-n', 'bash', '-c', script]]
    : ['ssh', [...sshArgs(shell, path.join(dir, 'known_hosts')), `sudo -n bash -c "$(echo ${Buffer.from(script).toString('base64')} | base64 -d)"`]];
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const capture = { child, clock: null, log, status: 'starting', target: shell.target };
  let stderr = '';
  let partial = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  return new Promise((resolve) => {
    const settle = (status, reason) => {
      if (capture.status !== 'starting') return;
      clearTimeout(timer);
      Object.assign(capture, { reason, status });
      resolve(capture);
    };
    const timer = setTimeout(() => settle('failed', `the lab did not start it within 30 s. ${stderr.trim()}`), 30000);
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      if (capture.status !== 'starting') return;
      const lines = `${partial}${chunk}`.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (line.startsWith('T ')) capture.clock = { lab: Number(line.slice(2)), local: now() };
        if (line.startsWith('E ')) settle('failed', line.slice(2));
        if (line.trim() === 'R') settle('on');
      }
    });
    child.on('error', (error) => settle('failed', error.message));
    child.on('exit', (code) => {
      if (capture.status === 'on' && !capture.stopping) Object.assign(capture, { endedAt: now(), reason: `ssh ended with ${code}: ${stderr.trim() || 'no output'}` });
      settle('failed', `ssh ended with ${code}: ${stderr.trim() || 'no output'}`);
    });
  });
}

async function stopServerCapture(capture) {
  const { child, log } = capture;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    capture.stopping = true;
    child.stdin.end();
    await Promise.race([once(child, 'exit'), sleep(15000)]);
    if (child.exitCode === null) child.kill();
  }
  if (!log.closed) await new Promise((resolve) => log.end(resolve));
}

function pageOf(request) {
  try {
    return request.serviceWorker()?.url() || request.frame().page().url();
  } catch {
    return '';
  }
}

// A browser context's requests to hosts outside the suite, with the page that made each.
function watchContext(context, network, ctx) {
  context.on('request', (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    const host = hostName(url.hostname);
    if (!/^https?:$/u.test(url.protocol) || host === 'localhost' || underAny(host, network.suites)) return;
    network.browser.push({ at: now(), host, page: pageOf(request), step: ctx.stepIndex, type: request.resourceType(), url: `${url.origin}${url.pathname}` });
  });
}

export async function startNetworkCapture(ctx) {
  const dir = path.join(ctx.resultsDir, 'network');
  fs.mkdirSync(dir, { recursive: true });
  const network = { browser: [], dir, suites: new Set([suiteBase(ctx.env.baseURL)]) };
  network.server = await startServerCapture(ctx.env.labShell, dir);
  network.watch = (context) => watchContext(context, network, ctx);
  network.watch(ctx.page.context());
  console.log(`[network] browser capture on; server capture ${network.server.status === 'on' ? `on, from ${network.server.target}` : `${network.server.status}: ${network.server.reason}`}`);
  return network;
}

function parsePacket(line) {
  const match = PACKET.exec(line);
  if (!match) return null;
  const [, at, iface = '', src, sport, dst, dport, rest] = match;
  // A container's packet crosses its veth, its bridge and the uplink; the bridge copy carries the container's own address.
  const packet = { at: Number(at), bridge: /^(?:br-|docker\d)/u.test(iface), dport: Number(dport), dst, sport: Number(sport), src };
  const query = QUERY.exec(rest);
  if (query) return { ...packet, id: query[1], kind: 'query', name: hostName(query[2]) };
  const answer = ANSWER.exec(rest);
  if (answer) return { ...packet, addresses: [...answer[2].matchAll(/\bA (\d+\.\d+\.\d+\.\d+)/gu)].map((found) => found[1]), id: answer[1], kind: 'answer' };
  return packet.bridge ? { ...packet, kind: rest.startsWith('Flags [S]') ? 'tcp' : 'udp' } : null;
}

export function parseServerLog(text) {
  const log = { addresses: [], containers: [], controls: [], error: null, lookups: [], packets: [], ready: false, search: [], start: null, stops: [] };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const [tag, ...rest] = line.split(/\s+/u);
    if (tag === 'T') log.start = Number(rest[0]);
    else if (tag === 'H') log.addresses = rest;
    else if (tag === 'S') log.search = rest.map(hostName);
    else if (tag === 'C') log.containers.push({ addresses: rest.slice(2).filter((item) => /^\d+\.\d+\.\d+\.\d+$/u.test(item)), at: Number(rest[0]), name: rest[1] });
    else if (tag === 'N') {
      const packet = parsePacket(rest.slice(1).join(' '));
      if (packet?.kind === 'query') log.lookups.push({ at: packet.at, container: rest[0], name: packet.name });
    } else if (tag === 'X') log.controls.push({ address: rest[2], at: Number(rest[0]), name: rest[1] });
    else if (tag === 'D') log.stops.push({ at: Number(rest[0]), name: rest[1] });
    else if (tag === 'R') log.ready = true;
    else if (tag === 'E') log.error = rest.join(' ');
    else {
      const packet = parsePacket(line);
      if (packet) log.packets.push(packet);
    }
  }
  return log;
}

function containerAt(containers, address, at) {
  let found = null;
  for (const container of containers) {
    if (container.at <= at + START_SLACK_S && container.addresses.includes(address) && (!found || container.at > found.at)) found = container;
  }
  return found;
}

// Every address any lookup on the machine answered with, and the names it answered for.
function answeredNames(packets) {
  const queries = new Map();
  const names = new Map();
  for (const packet of packets) {
    if (packet.kind === 'query') queries.set(`${packet.src}:${packet.sport}:${packet.id}`, packet.name);
    const name = packet.kind === 'answer' && queries.get(`${packet.dst}:${packet.dport}:${packet.id}`);
    for (const address of name ? packet.addresses : []) {
      if (!names.has(address)) names.set(address, new Set());
      names.get(address).add(name);
    }
  }
  return names;
}

// Every lookup an app container made and every connection a container opened. A
// connection takes the name its own container looked up for the address, else the only
// name any lookup gave it; an address shared by several names stays an address.
export function serverEvents(log) {
  const lookups = log.lookups.map((lookup) => ({ at: lookup.at, container: lookup.container, host: lookup.name, via: 'dns' }));
  for (const packet of log.packets.filter((item) => item.bridge && item.kind === 'query')) {
    const container = containerAt(log.containers, packet.src, packet.at);
    if (container) lookups.push({ at: packet.at, container: container.name, host: packet.name, via: 'dns' });
  }
  const names = answeredNames(log.packets);
  const connections = [];
  for (const packet of log.packets.filter((item) => item.kind === 'tcp' || item.kind === 'udp')) {
    const container = containerAt(log.containers, packet.src, packet.at);
    if (!container) continue;
    const candidates = [...(names.get(packet.dst) || [])];
    const own = candidates.filter((name) => lookups.some((lookup) => lookup.container === container.name && lookup.host === name));
    const host = own[0] || (candidates.length === 1 ? candidates[0] : packet.dst);
    connections.push({ address: packet.dst, at: packet.at, container: container.name, host, port: packet.dport, via: packet.kind });
  }
  return [...lookups, ...connections].sort((left, right) => left.at - right.at);
}

// Silence from a container means something only once its control showed up in the capture.
// A container that stopped before its control, or while it ran, is not checked rather than failed.
export function controlChecks(log, events) {
  return log.containers.filter((container) => container.name.startsWith(APP_CONTAINER)).map((container) => {
    const later = (item) => item.name === container.name && item.at > container.at;
    const end = Math.min(...[...log.containers.filter(later), ...log.stops.filter(later)].map((item) => item.at), Infinity);
    const control = log.controls.find((item) => item.name === container.name && item.at >= container.at && item.at < end);
    const seen = events.filter((event) => event.container === container.name && event.at >= container.at - START_SLACK_S && event.at < end);
    return {
      at: container.at,
      connection: Boolean(control) && seen.some((event) => event.via === 'tcp' && event.address === control.address),
      dns: seen.some((event) => event.via === 'dns' && event.host === CONTROL_HOST),
      name: container.name,
      ran: Boolean(control) && end - control.at > CONTROL_LIFETIME_S,
    };
  });
}

export function appOfContainer(name, appIds) {
  return [...appIds].sort((left, right) => right.length - left.length)
    .find((id) => name === `${APP_CONTAINER}${id}` || name.startsWith(`${APP_CONTAINER}${id}-`)) || null;
}

function pageHost(pageUrl) {
  try {
    return hostName(new URL(pageUrl).hostname);
  } catch {
    return '';
  }
}

// The app whose address the page is on; null for the suite's own pages, undefined for
// a page outside the suite, which belongs to whatever app the step was using.
function appOfPage(pageUrl, suites, appsByRouteHost) {
  const host = pageHost(pageUrl);
  for (const base of suites) {
    if (host === base) return null;
    if (host.endsWith(`.${base}`)) return appsByRouteHost.get(host.slice(0, -base.length - 1)) || null;
  }
  return undefined;
}

export function matchesHost(host, pattern) {
  if (pattern === '*') return true;
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
}

// What each app's privacy review says it contacts, by channel: the review in this checkout,
// which in an update run is the version updated to.
export function expectationsFrom(reviews) {
  return Object.fromEntries(Object.entries(reviews).map(([id, review]) => [id, {
    browser: (review?.outbound || []).filter((item) => item.from === 'browser').map((item) => item.host),
    server: (review?.outbound || []).filter((item) => item.from === 'server').map((item) => item.host),
  }]));
}

function stepAt(timeline, at) {
  return timeline.filter((step) => step.start <= at).at(-1) || null;
}

// Each app's destinations by channel and host: where they came from, in which steps, and
// whether they were seen before its update, after it, or both.
export function summarize({ appIds, appsByRouteHost = new Map(), browser = [], expectations = {}, log, suites, timeline = [], toLocal = (at) => at }) {
  const search = new Set(log?.search || []);
  const ownAddresses = new Set(log?.addresses || []);
  const controlAddresses = new Set((log?.controls || []).map((control) => control.address));
  const ignored = (event) => event.host === CONTROL_HOST || controlAddresses.has(event.address) || ownAddresses.has(event.address)
    || !event.host.includes('.') || LOCAL_SUFFIXES.some((suffix) => event.host.endsWith(suffix)) || underAny(event.host, search) || underAny(event.host, suites);

  const events = [
    ...(log ? serverEvents(log) : []).map((event) => ({ ...event, app: appOfContainer(event.container, appIds), at: toLocal(event.at), channel: 'server', from: event.container })),
    ...browser.map((record) => {
      const step = timeline[record.step];
      const owner = appOfPage(record.page, suites, appsByRouteHost);
      const app = owner === undefined && step && APP_STEPS.has(step.name) ? step.arg : owner || null;
      return { app, at: record.at, channel: 'browser', from: pageHost(record.page) || 'browser', host: record.host, url: record.url, via: record.type };
    }),
  ].filter((event) => !ignored(event));

  const groups = new Map();
  for (const event of events.sort((left, right) => left.at - right.at)) {
    const owner = event.app || 'platform';
    if (!groups.has(owner)) {
      const update = timeline.find((step) => step.name === 'update' && step.arg === owner);
      groups.set(owner, { destinations: new Map(), id: owner, updateStep: update || null });
    }
    const group = groups.get(owner);
    const key = `${event.channel} ${event.host}`;
    if (!group.destinations.has(key)) {
      const allowed = (expectations[owner]?.[event.channel] || []).some((pattern) => matchesHost(event.host, pattern));
      group.destinations.set(key, { channel: event.channel, count: 0, example: event.url || null, expected: owner === 'platform' ? null : allowed, first: event.at, from: new Set(), host: event.host, phases: new Set(), ports: new Set(), steps: new Set() });
    }
    const destination = group.destinations.get(key);
    destination.count += 1;
    destination.from.add(event.from);
    if (event.port) destination.ports.add(event.port);
    const step = stepAt(timeline, event.at);
    if (step) destination.steps.add(step.token);
    destination.phases.add(!group.updateStep ? 'run' : event.at < group.updateStep.start ? 'before' : 'after');
  }

  return [...groups.values()].map((group) => ({
    destinations: [...group.destinations.values()].map((item) => ({ ...item, from: [...item.from], phases: [...item.phases], ports: [...item.ports], steps: [...item.steps] })),
    id: group.id,
    updateStep: group.updateStep?.token || null,
  }));
}

export function problemsIn({ apps, checks, server }) {
  const problems = [];
  if (server.status !== 'on') problems.push(`The server capture is ${server.status}: ${server.reason}`);
  else if (server.endedAt) problems.push(`The server capture stopped during the run: ${server.reason}`);
  for (const check of checks) {
    if (check.ran && !(check.dns && check.connection)) problems.push(`The capture did not see ${check.name}'s control ${!check.dns ? 'lookup' : 'connection'}, so its silence proves nothing.`);
  }
  // A host only the version updated from contacted answers to that version's review, not this one.
  for (const app of apps.filter((item) => item.id !== 'platform')) {
    for (const destination of app.destinations.filter((item) => !item.expected && item.phases.some((phase) => phase !== 'before'))) {
      problems.push(`${app.id} contacted ${destination.host} (${destination.channel}, from ${destination.from.join(', ')}, in ${destination.steps.join(', ')}), which apps/${app.id}/privacy-review.json does not list under outbound. Assess it with skills/assess-app-privacy and record it there, or stop the app from contacting it.`);
    }
  }
  return problems;
}

function shortSource(from, id) {
  return from.startsWith(`${APP_CONTAINER}${id}-`) ? from.slice(APP_CONTAINER.length + id.length + 1) : from.startsWith(APP_CONTAINER) ? 'app' : from;
}

function listedLabel(item) {
  if (item.expected === null) return '';
  if (item.expected) return 'yes';
  return item.phases.every((phase) => phase === 'before') ? 'no, before the update only' : '**no**';
}

function appSection(app) {
  const updated = Boolean(app.updateStep);
  const rows = app.destinations.map((item) => [
    `\`${item.host}\``,
    item.channel,
    item.from.map((from) => shortSource(from, app.id)).join(', '),
    item.steps.join(', '),
    ...(updated ? [item.phases.includes('before') ? '✓' : '', item.phases.includes('after') ? '✓' : ''] : []),
    listedLabel(item),
  ]);
  const header = ['Host', 'Channel', 'From', 'Steps', ...(updated ? ['Before', 'After'] : []), 'In review'];
  const table = rows.length ? [header, header.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n') : 'Nothing: no lookup, no connection and no outside request.';
  const fresh = app.destinations.filter((item) => item.phases.includes('after') && !item.phases.includes('before'));
  const title = app.id === 'platform' ? 'Platform (not checked against a review)' : app.id;
  return [
    `## ${title}`,
    updated ? `Updated in \`${app.updateStep}\`: Before is everything until that step, After is from it on.` : '',
    table,
    updated ? `New after the update: ${fresh.length ? fresh.map((item) => `\`${item.host}\` (${item.channel})`).join(', ') : 'none'}.` : '',
  ].filter(Boolean).join('\n\n');
}

export function renderReport({ apps, checks, label, problems, server }) {
  const proven = checks.filter((check) => check.ran && check.dns && check.connection).length;
  const serverLine = server.status === 'on'
    ? `Server capture: on, from \`${server.target}\`. ${proven} of ${checks.filter((check) => check.ran).length} app containers showed their control lookup and connection.`
    : `Server capture: ${server.status}. ${server.reason}`;
  return `${[
    `# Network: ${label}`,
    `${serverLine}\nBrowser capture: on.`,
    'The server capture records every DNS lookup an app container makes and every connection it opens to a public address; the browser capture records every request to a host outside the suite. Neither decrypts traffic, and both see only what this run made the apps do.',
    problems.length ? `## Problems\n\n${problems.map((problem) => `- ${problem}`).join('\n')}` : '## Problems\n\nNone.',
    ...[...apps].sort((left, right) => (left.id === 'platform') - (right.id === 'platform') || left.id.localeCompare(right.id)).map(appSection),
  ].join('\n\n')}\n`;
}

function reviewsFor(appIds) {
  return Object.fromEntries(appIds.map((id) => {
    const file = path.join(repoRoot, 'apps', id, 'privacy-review.json');
    return [id, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
  }));
}

// Writes network/report.md and report.json from everything captured so far.
export async function writeNetworkReport(ctx) {
  const { network } = ctx;
  const catalog = catalogApps();
  const appIds = catalog.map((item) => item.id);
  const appsByRouteHost = new Map(catalog.flatMap((item) => item.routeHosts.map((host) => [host, item.id])));
  const logFile = path.join(network.dir, 'server.log');
  const log = network.server.status === 'on' && fs.existsSync(logFile) ? parseServerLog(fs.readFileSync(logFile, 'utf8')) : null;
  const { clock } = network.server;
  const toLocal = clock ? (at) => at - clock.lab + clock.local : (at) => at;
  const apps = summarize({ appIds, appsByRouteHost, browser: network.browser, expectations: expectationsFrom(reviewsFor(appIds)), log, suites: network.suites, timeline: ctx.timeline, toLocal });
  const checks = log ? controlChecks(log, serverEvents(log)).map((check) => ({ ...check, at: toLocal(check.at) })) : [];
  const problems = problemsIn({ apps, checks, server: network.server });
  const label = ctx.plan.label || ctx.runId;
  fs.writeFileSync(path.join(network.dir, 'report.md'), renderReport({ apps, checks, label, problems, server: network.server }));
  fs.writeFileSync(path.join(network.dir, 'report.json'), `${JSON.stringify({ apps, checks, label, problems, server: { reason: network.server.reason || null, status: network.server.status, target: network.server.target || null } }, null, 2)}\n`);
  return { apps, problems };
}

export async function finishNetworkCapture(ctx) {
  await stopServerCapture(ctx.network.server);
  return writeNetworkReport(ctx);
}
