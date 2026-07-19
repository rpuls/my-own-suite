const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createInitialPlatformContract,
  plannedValidationCommands,
  validateInitialPlatformContract,
} = require('../src/platform-contract.cjs');

test('initial MOS contract is clean-slate, Suite Manager-first, and app-free', () => {
  const contract = createInitialPlatformContract();

  assert.equal(contract.version, 1);
  assert.equal(contract.firstMilestone, 'suite-manager-owner-setup');
  assert.deepEqual(contract.defaultComponents, ['suite-manager', 'homepage', 'caddy', 'host-agents']);
  assert.deepEqual(contract.optionalApps, []);
  assert.equal(contract.installer.requiresOwnerCredentials, false);
  assert.equal(contract.ownerSetup.location, 'suite-manager-browser');
  assert.equal(contract.oldSystemPolicy.snapshotBranch, 'archive/mos1-main-snapshot');
  assert.equal(contract.oldSystemPolicy.runtimeImportsFromOldSuiteManager, false);
  assert.deepEqual(validateInitialPlatformContract(contract), []);
});

test('contract rejects preloaded app assumptions', () => {
  const contract = createInitialPlatformContract();
  contract.optionalApps.push('stirling-pdf');

  assert.deepEqual(validateInitialPlatformContract(contract), [
    'Slice 1 must not preload optional apps.',
  ]);
});

test('contract rejects runtime dependence on the old Suite Manager', () => {
  const contract = createInitialPlatformContract();
  contract.oldSystemPolicy.runtimeImportsFromOldSuiteManager = true;

  assert.deepEqual(validateInitialPlatformContract(contract), [
    'MOS must not import the old Suite Manager at runtime.',
  ]);
});

test('validation is scoped to MOS and leaves smoke/E2E user-run', () => {
  assert.deepEqual(plannedValidationCommands(), [
    {
      command: 'npm test',
      owner: 'agent',
      purpose: 'Validate the clean-slate MOS workspace contract.',
    },
    {
      command: 'npm run smoke:do:reset',
      owner: 'user',
      purpose: 'Run paid DigitalOcean fresh-install validation once MOS has an install path.',
    },
    {
      command: 'npm run e2e:onboarding',
      owner: 'user',
      purpose: 'Run noisy browser validation once the MOS first-run owner flow is implemented.',
    },
  ]);
});
