const DEFAULT_COMPONENTS = ['suite-manager', 'homepage', 'caddy', 'host-agents'];

function createInitialPlatformContract() {
  return {
    defaultComponents: [...DEFAULT_COMPONENTS],
    firstMilestone: 'suite-manager-owner-setup',
    installer: {
      frontDoors: ['cloud-init', 'usb-autoinstall', 'ssh-bootstrap'],
      requiresOwnerCredentials: false,
      sharedRuntime: 'ubuntu-24.04-own-infra',
    },
    optionalApps: [],
    ownerSetup: {
      createsSession: true,
      location: 'suite-manager-browser',
      requiredFields: ['name', 'email', 'password'],
      storesPasswordHash: true,
    },
    testing: {
      digitalOceanHarness: 'reuse-existing',
      e2e: 'owner-creation-flow-before-merge',
      smokeCommandsAreUserRun: true,
    },
    ui: {
      designFramework: 'suite-manager-shared-components',
      primitiveSource: 'apps/suite-manager/frontend/src/components/ui.tsx',
    },
    version: 1,
  };
}

function validateInitialPlatformContract(contract) {
  const errors = [];

  if (contract.firstMilestone !== 'suite-manager-owner-setup') {
    errors.push('Slice 1 must start with Suite Manager owner setup.');
  }

  if (contract.installer?.requiresOwnerCredentials !== false) {
    errors.push('Installer must not require owner credentials for the V2 first slice.');
  }

  if (contract.ownerSetup?.location !== 'suite-manager-browser') {
    errors.push('Owner creation must happen in the Suite Manager browser flow.');
  }

  if (Array.isArray(contract.optionalApps) && contract.optionalApps.length > 0) {
    errors.push('Slice 1 must not preload optional apps.');
  }

  for (const component of DEFAULT_COMPONENTS) {
    if (!contract.defaultComponents?.includes(component)) {
      errors.push(`Missing default control-plane component: ${component}.`);
    }
  }

  if (contract.testing?.smokeCommandsAreUserRun !== true) {
    errors.push('DigitalOcean smoke commands must remain user-run because they create paid resources.');
  }

  return errors;
}

function plannedValidationCommands() {
  return [
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
  ];
}

module.exports = {
  createInitialPlatformContract,
  plannedValidationCommands,
  validateInitialPlatformContract,
};
