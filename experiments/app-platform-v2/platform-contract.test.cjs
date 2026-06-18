const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createInitialPlatformContract,
  plannedValidationCommands,
  validateInitialPlatformContract,
} = require('./src/platform-contract.cjs');

test('initial V2 contract is Suite Manager-first and app-free', () => {
  const contract = createInitialPlatformContract();

  assert.equal(contract.version, 1);
  assert.equal(contract.firstMilestone, 'suite-manager-owner-setup');
  assert.deepEqual(contract.defaultComponents, ['suite-manager', 'homepage', 'caddy', 'host-agents']);
  assert.deepEqual(contract.optionalApps, []);
  assert.equal(contract.installer.requiresOwnerCredentials, false);
  assert.equal(contract.ownerSetup.location, 'suite-manager-browser');
  assert.deepEqual(validateInitialPlatformContract(contract), []);
});

test('contract rejects preloaded app assumptions', () => {
  const contract = createInitialPlatformContract();
  contract.optionalApps.push('stirling-pdf');

  assert.deepEqual(validateInitialPlatformContract(contract), [
    'Slice 1 must not preload optional apps.',
  ]);
});

test('validation starts with cheap lab checks and leaves smoke/E2E user-run', () => {
  assert.deepEqual(plannedValidationCommands(), [
    {
      command: 'npm run v2:lab:test',
      owner: 'agent',
      purpose: 'Validate the isolated V2 lab contract.',
    },
    {
      command: 'npm --prefix apps/suite-manager test',
      owner: 'agent',
      purpose: 'Validate Suite Manager backend and frontend-adjacent unit coverage after implementation changes.',
    },
    {
      command: 'npm run smoke:do:up',
      owner: 'user',
      purpose: 'Run paid DigitalOcean fresh-install validation from the V2 branch.',
    },
    {
      command: 'npm run e2e:onboarding',
      owner: 'user',
      purpose: 'Run noisy browser validation once the first-run owner flow is implemented.',
    },
  ]);
});
