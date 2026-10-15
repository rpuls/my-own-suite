import assert from 'node:assert/strict';
import test from 'node:test';

import { appOfContainer, controlChecks, expectationsFrom, matchesHost, parseServerLog, problemsIn, renderReport, serverEvents, summarize } from '../e2e/support/network.mjs';

// Docker answers a container's lookups from the host (lo, 127.0.0.53), so the container's
// own lookups arrive as N lines and its connections on the bridge.
const LOG = `T 1000.0
H 172.26.1.5 172.17.0.1 172.18.0.1
S mshome.net
C 1001.0 mos-app-notes-web 172.18.0.2
C 1001.1 mos-app-notes-db 172.18.0.3
C 1001.2 mos-caddy 172.19.0.2
R
N mos-app-notes-web 1002.000000 IP 127.0.0.1.40001 > 127.0.0.11.45678: 7+ [1au] A? example.com. (40)
1002.000100 lo    In  IP 127.0.0.1.50001 > 127.0.0.53.53: 7001+ [1au] A? example.com. (40)
1002.010000 lo    In  IP 127.0.0.53.53 > 127.0.0.1.50001: 7001 2/0/1 A 93.184.215.14, A 93.184.215.15 (72)
1002.100000 vethab12 P   IP 172.18.0.2.50000 > 93.184.215.14.443: Flags [S], seq 1, win 64240, length 0
1002.100001 br-0a1b2c3d In  IP 172.18.0.2.50000 > 93.184.215.14.443: Flags [S], seq 1, win 64240, length 0
1002.100002 eth0  Out IP 172.26.1.5.50000 > 93.184.215.14.443: Flags [S], seq 1, win 64240, length 0
X 1003.0 mos-app-notes-web 93.184.215.14
N mos-app-notes-db 1002.200000 IP 127.0.0.1.40002 > 127.0.0.11.45679: 8+ [1au] A? example.com. (40)
X 1003.1 mos-app-notes-db 93.184.215.14
N mos-app-notes-web 1010.000000 IP 127.0.0.1.40003 > 127.0.0.11.45678: 9+ A? models.example.org. (36)
1010.000100 lo    In  IP 127.0.0.1.50003 > 127.0.0.53.53: 9001+ [1au] A? models.example.org. (36)
1010.010000 lo    In  IP 127.0.0.53.53 > 127.0.0.1.50003: 9001 2/0/1 CNAME cdn.example.net., A 203.0.113.7 (90)
1010.020000 lo    In  IP 127.0.0.1.50004 > 127.0.0.53.53: 9002+ [1au] A? other.example.com. (36)
1010.030000 lo    In  IP 127.0.0.53.53 > 127.0.0.1.50004: 9002 1/0/1 A 203.0.113.7 (52)
1010.200000 br-0a1b2c3d In  IP 172.18.0.2.50001 > 203.0.113.7.443: Flags [S], seq 2, win 64240, length 0
1011.000000 br-0a1b2c3d In  IP 172.18.0.2.50002 > 198.51.100.9.443: Flags [S], seq 3, win 64240, length 0
1011.500000 br-0a1b2c3d In  IP 172.18.0.2.40005 > 172.26.0.1.53: 11+ A? db.mshome.net. (31)
1012.000000 br-1111 In  IP 172.19.0.2.50003 > 203.0.113.50.443: Flags [S], seq 4, win 64240, length 0
1013.000000 br-0a1b2c3d In  IP 172.18.0.2.41000 > 203.0.113.80.123: NTPv4, Client, length 48
`;

const appIds = ['notes', 'notes-sync'];

test('the capture log parses into containers, lookups, controls and packets', () => {
  const log = parseServerLog(LOG);
  assert.equal(log.ready, true);
  assert.deepEqual(log.search, ['mshome.net']);
  assert.equal(log.containers.length, 3);
  assert.deepEqual(log.controls.map((control) => control.name), ['mos-app-notes-web', 'mos-app-notes-db']);
  assert.deepEqual(log.lookups.map((lookup) => `${lookup.container} ${lookup.name}`), ['mos-app-notes-web example.com', 'mos-app-notes-db example.com', 'mos-app-notes-web models.example.org']);
  assert.equal(log.packets.filter((packet) => packet.kind === 'tcp').length, 4, 'only the bridge copy of a connection is kept');
  assert.deepEqual(log.packets.find((packet) => packet.kind === 'answer' && packet.id === '9001').addresses, ['203.0.113.7']);
});

test("a connection takes its own container's lookup, else the only name its address had", () => {
  const events = serverEvents(parseServerLog(LOG));
  const shared = events.find((event) => event.address === '203.0.113.7');
  assert.equal(shared.host, 'models.example.org', 'the address also answered other.example.com');
  assert.equal(shared.container, 'mos-app-notes-web');
  assert.equal(events.find((event) => event.address === '93.184.215.14').host, 'example.com');
  assert.equal(events.find((event) => event.address === '198.51.100.9').host, '198.51.100.9', 'an address nobody looked up stays an address');
  assert.equal(events.find((event) => event.via === 'udp').port, 123);
  assert.ok(events.some((event) => event.via === 'dns' && event.host === 'db.mshome.net'), 'a lookup that crossed the bridge counts too');
});

test('a container is proven only when both its control lookup and connection were seen', () => {
  const log = parseServerLog(LOG);
  const checks = controlChecks(log, serverEvents(log));
  assert.deepEqual(checks.map(({ connection, dns, name }) => ({ connection, dns, name })), [
    { connection: true, dns: true, name: 'mos-app-notes-web' },
    { connection: false, dns: true, name: 'mos-app-notes-db' },
  ]);
  const problems = problemsIn({ apps: [], checks, server: { status: 'on' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mos-app-notes-db's control connection/u);
});

test("a control proves only its own container, and one stopped before or during its control is not checked", () => {
  const log = parseServerLog(`T 1.0
C 10.0 mos-app-notes 172.18.0.2
D 10.5 mos-app-notes
C 11.0 mos-app-notes-db 172.18.0.3
X 12.0 mos-app-notes-db 93.184.215.14
D 12.1 mos-app-notes-db
C 20.0 mos-app-notes 172.18.0.2
R
N mos-app-notes 21.000000 IP 127.0.0.1.4000 > 127.0.0.11.4567: 1+ A? example.com. (30)
21.100000 br-1 In  IP 172.18.0.2.5000 > 93.184.215.14.443: Flags [S], seq 1, win 1, length 0
X 21.2 mos-app-notes 93.184.215.14
`);
  const checks = controlChecks(log, serverEvents(log));
  assert.deepEqual(checks.map(({ connection, dns, name, ran }) => ({ connection, dns, name, ran })), [
    { connection: false, dns: false, name: 'mos-app-notes', ran: false },
    { connection: false, dns: false, name: 'mos-app-notes-db', ran: false },
    { connection: true, dns: true, name: 'mos-app-notes', ran: true },
  ]);
  assert.deepEqual(problemsIn({ apps: [], checks, server: { status: 'on' } }), []);
});

test('a container belongs to the longest app id it is named after', () => {
  assert.equal(appOfContainer('mos-app-notes-sync-worker', appIds), 'notes-sync');
  assert.equal(appOfContainer('mos-app-notes', appIds), 'notes');
  assert.equal(appOfContainer('mos-caddy', appIds), null);
});

test('a host pattern is exact unless it starts with a wildcard label, and * is any host', () => {
  assert.equal(matchesHost('cdn.example.net', '*.example.net'), true);
  assert.equal(matchesHost('example.net', '*.example.net'), false);
  assert.equal(matchesHost('version.example.net', 'tiles.example.net'), false);
  assert.equal(matchesHost('saved-site.example', '*'), true);
});

test("the hosts an app may contact come from its privacy review's outbound list, by channel", () => {
  const outbound = [
    { from: 'browser', host: 'tiles.example.net', purpose: 'Map tiles.', receiver: 'Example' },
    { from: 'server', host: '*.example.org', purpose: 'Models.', receiver: 'Example' },
  ];
  assert.deepEqual(expectationsFrom({ notes: { outbound }, quiet: { outbound: [] }, unreviewed: null }), {
    notes: { browser: ['tiles.example.net'], server: ['*.example.org'] },
    quiet: { browser: [], server: [] },
    unreviewed: { browser: [], server: [] },
  });
});

const timeline = [
  { arg: 'notes', index: 0, name: 'app', start: 1000, token: 'app:notes' },
  { arg: 'notes', index: 1, name: 'update', start: 1010.5, token: 'update:notes' },
  { arg: 'notes', index: 2, name: 'verify', start: 1020, token: 'verify:notes' },
];

test('destinations are grouped per app, split around its update, and held to its expectations', () => {
  const browser = [
    { at: 1005, host: 'tiles.example.net', page: 'http://notes.mos.test/map', step: 0, type: 'image', url: 'https://tiles.example.net/1/2/3.mvt' },
    { at: 1021, host: 'telemetry.example.com', page: 'http://notes.mos.test/', step: 2, type: 'fetch', url: 'https://telemetry.example.com/e' },
    { at: 1022, host: 'docs.example.com', page: 'https://docs.example.com/help', step: 2, type: 'document', url: 'https://docs.example.com/help' },
    { at: 1023, host: 'fonts.example.com', page: 'http://home.mos.test/suite-manager/', step: 2, type: 'font', url: 'https://fonts.example.com/a.woff2' },
  ];
  const apps = summarize({
    appIds,
    appsByRouteHost: new Map([['notes', 'notes']]),
    browser,
    expectations: { notes: { browser: ['tiles.example.net', 'docs.example.com'], server: [] } },
    log: parseServerLog(LOG),
    suites: new Set(['mos.test']),
    timeline,
  });
  const notes = apps.find((app) => app.id === 'notes');
  const byHost = Object.fromEntries(notes.destinations.map((item) => [`${item.channel} ${item.host}`, item]));
  assert.deepEqual(Object.keys(byHost).sort(), [
    'browser docs.example.com',
    'browser telemetry.example.com',
    'browser tiles.example.net',
    'server 198.51.100.9',
    'server 203.0.113.80',
    'server models.example.org',
  ], 'the control, the search-domain lookup and the platform are left out');
  assert.deepEqual(byHost['server models.example.org'].phases, ['before']);
  assert.deepEqual(byHost['browser telemetry.example.com'].phases, ['after']);
  assert.equal(byHost['browser telemetry.example.com'].example, 'https://telemetry.example.com/e');
  assert.equal(byHost['browser tiles.example.net'].expected, true);
  assert.equal(byHost['server models.example.org'].expected, false);
  assert.equal(byHost['browser telemetry.example.com'].expected, false);
  assert.deepEqual(byHost['browser docs.example.com'].from, ['docs.example.com'], 'a page outside the suite belongs to the app step that opened it');
  assert.equal(apps.find((app) => app.id === 'platform').destinations.length, 2, "the suite's own page and the platform container");

  const problems = problemsIn({ apps, checks: [], server: { status: 'on' } });
  assert.equal(problems.length, 3, 'the host only the old version contacted is not held to the new review');
  assert.ok(problems.some((problem) => /notes contacted telemetry\.example\.com \(browser.*does not list under outbound/u.test(problem)));
  assert.ok(!problems.some((problem) => problem.includes('models.example.org')));

  const report = renderReport({ apps, checks: [], label: '@update notes', problems, server: { status: 'on', target: 'mos@lab' } });
  assert.match(report, /New after the update: .*`telemetry\.example\.com` \(browser\)/u);
  assert.match(report, /\| `models\.example\.org` \| server \| web \| app:notes \| ✓ \|  \| no, before the update only \|/u);
});

test('a run without a lab shell says so instead of reporting silence', () => {
  const problems = problemsIn({ apps: [], checks: [], server: { reason: 'there is no root shell on the lab.', status: 'off' } });
  assert.deepEqual(problems, ['The server capture is off: there is no root shell on the lab.']);
});
