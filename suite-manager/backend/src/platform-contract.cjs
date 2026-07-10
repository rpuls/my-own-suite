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
    oldSystemPolicy: {
      mos1SiteReferencePath: 'site-mos1-reference',
      runtimeImportsFromOldSuiteManager: false,
      snapshotBranch: 'archive/mos1-main-snapshot',
    },
    optionalApps: [],
    ownerSetup: {
      createsSession: true,
      location: 'suite-manager-browser',
      requiredFields: ['name', 'email', 'password'],
      storesPasswordHash: true,
    },
    testing: {
      digitalOceanHarness: 'v2-owned-smoke-harness',
      e2e: 'owner-creation-flow-before-merge',
      smokeCommandsAreUserRun: true,
    },
    ui: {
      designFramework: 'suite-manager-v2-shared-primitives',
      referencePrimitiveSource: 'suite-manager/frontend/src/components/ui.tsx',
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

  if (contract.oldSystemPolicy?.snapshotBranch !== 'archive/mos1-main-snapshot') {
    errors.push('MOS1 must remain recoverable through the archive snapshot branch.');
  }

  if (contract.oldSystemPolicy?.runtimeImportsFromOldSuiteManager !== false) {
    errors.push('V2 must not import the old Suite Manager at runtime.');
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
      command: 'npm test',
      owner: 'agent',
      purpose: 'Validate the clean-slate V2 workspace contract.',
    },
    {
      command: 'npm run smoke:do:reset',
      owner: 'user',
      purpose: 'Run paid DigitalOcean fresh-install validation once V2 has an install path.',
    },
    {
      command: 'npm run e2e:onboarding',
      owner: 'user',
      purpose: 'Run noisy browser validation once the V2 first-run owner flow is implemented.',
    },
  ];
}

module.exports = {
  createInitialPlatformContract,
  plannedValidationCommands,
  validateInitialPlatformContract,
};
