'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DiagnosticsAgentCore,
  LIMITS,
  MOS_UNITS,
  boundText,
  containerLooksTroubled,
  fitLogsToBudget,
  mapWithLimit,
  unitLooksTroubled,
} = require('./agent-core.cjs');

function adapter(overrides = {}) {
  return {
    availableCollectors: async () => ({ docker: true, journal: true }),
    containerLog: async (name, lines) => `log for ${name} (${lines} lines)`,
    containers: async () => [],
    hostFacts: async () => ({ disk: 'df', kernel: 'linux' }),
    journal: async (unit, lines) => `journal for ${unit} (${lines} lines)`,
    unitState: async () => ({ active: 'active', enabled: 'enabled', sub: 'running' }),
    ...overrides,
  };
}

test('collect takes no arguments, so no caller can widen what is read', () => {
  // Structural rather than behavioural on purpose. The security argument for a
  // root agent that reads host state is that the collector list is compiled in;
  // the moment `collect` grows a parameter, that argument needs remaking, and
  // this test is what forces someone to notice.
  assert.equal(DiagnosticsAgentCore.prototype.collect.length, 0);
});

test('a healthy unit contributes a short tail and a sick one the full budget', async () => {
  const requested = new Map();
  const core = new DiagnosticsAgentCore(adapter({
    journal: async (unit, lines) => { requested.set(unit, lines); return 'lines'; },
    unitState: async (unit) => (unit === 'caddy.service'
      ? { active: 'failed', enabled: 'enabled', sub: 'failed' }
      : { active: 'active', enabled: 'enabled', sub: 'running' }),
  }));

  await core.collect();

  assert.equal(requested.get('caddy.service'), LIMITS.troubledLines);
  assert.equal(requested.get('mos-app-agent.service'), LIMITS.healthyLines);
  // Suite Manager is always read in full: it explains failures that surface in
  // the other units.
  assert.equal(requested.get('mos-suite-manager.service'), LIMITS.troubledLines);
});

test('one failing collector does not lose the rest of the bundle', async () => {
  const core = new DiagnosticsAgentCore(adapter({
    hostFacts: async () => { throw new Error('no /usr/bin/df'); },
    journal: async (unit) => {
      if (unit === 'docker.service') throw new Error('journalctl missing');
      return `journal for ${unit}`;
    },
  }));

  const result = await core.collect();

  assert.deepEqual(result.host, {});
  assert.equal(result.units.length, MOS_UNITS.length);
  assert.ok(result.incomplete.includes('host'));
  assert.ok(result.incomplete.includes('journal:docker.service'));
  assert.equal(result.units.find((unit) => unit.name === 'caddy.service').log, 'journal for caddy.service');
});

test('only MOS containers are collected, and only up to the cap', async () => {
  const core = new DiagnosticsAgentCore(adapter({
    containers: async () => [
      { name: 'someone-elses-database', state: 'running', status: 'Up 3 days' },
      ...Array.from({ length: LIMITS.containers + 5 }, (unused, index) => ({
        name: `mos-app-example-${index}`,
        state: 'running',
        status: 'Up 2 hours',
      })),
    ],
  }));

  const result = await core.collect();

  assert.equal(result.containers.length, LIMITS.containers);
  assert.ok(!result.containers.some((container) => container.name === 'someone-elses-database'));
});

test('bounding keeps the newest text and says what it dropped', () => {
  const text = Array.from({ length: 500 }, (unused, index) => `line ${index}`).join('\n');
  const bounded = boundText(text, 200);

  assert.ok(bounded.length <= 260, bounded.length);
  assert.ok(bounded.startsWith('[... '));
  assert.ok(bounded.includes('earlier characters dropped'));
  assert.ok(bounded.trimEnd().endsWith('line 499'));
  assert.ok(!bounded.includes('line 0\n'));
});

test('bounding leaves text that already fits completely alone', () => {
  assert.equal(boundText('short', 200), 'short');
  assert.equal(boundText('', 200), '');
  assert.equal(boundText(undefined, 200), '');
});

test('trouble detection covers the states an owner cannot see for themselves', () => {
  assert.equal(unitLooksTroubled({ active: 'active' }), false);
  assert.equal(unitLooksTroubled({ active: 'failed' }), true);
  assert.equal(unitLooksTroubled({ active: 'activating' }), true);

  assert.equal(containerLooksTroubled({ state: 'running', status: 'Up 2 hours' }), false);
  assert.equal(containerLooksTroubled({ state: 'exited', status: 'Exited (137) 5 minutes ago' }), true);
  assert.equal(containerLooksTroubled({ state: 'running', status: 'Up 2 hours (unhealthy)' }), true);
  assert.equal(containerLooksTroubled({ state: 'restarting', status: 'Restarting (1) 2 seconds ago' }), true);
});

test('collection never runs more than the concurrency limit at once', async () => {
  let running = 0;
  let peak = 0;
  const slow = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return 'x';
  };
  const core = new DiagnosticsAgentCore(adapter({
    containerLog: slow,
    containers: async () => Array.from({ length: 20 }, (unused, index) => ({ name: `mos-app-${index}`, state: 'running', status: 'Up' })),
    hostFacts: slow,
    journal: slow,
    unitState: async () => { await slow(); return { active: 'active', enabled: 'enabled', sub: 'running' }; },
  }));

  await core.collect();

  // Units and containers each get their own pool, plus the single host read, so
  // the ceiling is two pools and one. What matters is that it is bounded and
  // does not scale with the number of containers on the machine.
  assert.ok(peak <= LIMITS.concurrency * 2 + 1, `peak concurrency was ${peak}`);
});

test('bounded mapping preserves input order', async () => {
  const order = await mapWithLimit([5, 1, 4, 2, 3], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value));
    return value;
  });

  assert.deepEqual(order, [5, 1, 4, 2, 3]);
});

test('the whole collection is bounded, not merely each section of it', async () => {
  // Twenty-four containers and nine units at the per-section cap is 770 KB —
  // a file nobody reads, and past what many readers can hold at all. The size
  // that has to be true is the total.
  const noisy = 'x'.repeat(LIMITS.sectionChars);
  const core = new DiagnosticsAgentCore(adapter({
    containerLog: async () => noisy,
    containers: async () => Array.from({ length: LIMITS.containers }, (unused, index) => ({
      name: `mos-app-${index}`,
      state: 'running',
      status: 'Up 2 hours',
    })),
    journal: async () => noisy,
  }));

  const result = await core.collect();
  const total = [...result.units, ...result.containers].reduce((sum, entry) => sum + entry.log.length, 0);

  assert.equal(result.budgetApplied, true);
  assert.ok(total <= LIMITS.totalLogChars * 1.1, `collected ${total} characters`);
});

test('a quiet machine keeps every log in full', async () => {
  const core = new DiagnosticsAgentCore(adapter({
    containers: async () => [{ name: 'mos-app-example', state: 'running', status: 'Up' }],
  }));

  const result = await core.collect();

  assert.equal(result.budgetApplied, false);
  assert.equal(result.containers[0].log, 'log for mos-app-example (40 lines)');
});

test('the budget is spent on what looks wrong, not shared out equally', () => {
  const noisy = (troubled, name) => ({ log: 'x'.repeat(50_000), name, troubled });
  const { budgetApplied, containers, units } = fitLogsToBudget(
    [noisy(true, 'broken.service')],
    [noisy(false, 'mos-app-a'), noisy(false, 'mos-app-b'), noisy(false, 'mos-app-c')],
    20_000,
  );

  assert.equal(budgetApplied, true);
  assert.ok(units[0].log.length > containers[0].log.length, 'the failed unit should keep more than a healthy container');
});

test('no section is starved below the point of being worth reading', () => {
  const many = Array.from({ length: 200 }, (unused, index) => ({ log: 'x'.repeat(10_000), name: `mos-app-${index}`, troubled: false }));
  const { containers } = fitLogsToBudget([], many, 1_000);

  assert.ok(containers.every((entry) => entry.log.length >= LIMITS.minLogChars));
});
