import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction } from '../shared/types.ts';

function field(label: string, value: string, secret = false) {
  return {
    label,
    secret,
    value,
  };
}

export function buildVaultwardenSteps(
  config: SuiteManagerConfig,
  vaultwardenAccountReady: boolean,
  suiteCredentialsImported: boolean,
  completionSource: {
    import: 'database' | 'manual' | 'none';
    vaultwardenAccount: 'database' | 'manual' | 'none';
  },
): CurrentAction[] {
  const activateVaultwarden: CurrentAction = {
    completion: {
      mode: 'automatic',
      source: completionSource.vaultwardenAccount,
    },
    detection: {
      actionSectionIds: ['create-admin-user'],
      pollIntervalMs: 1000,
      pollWhileActive: true,
      revealDelayMs: 1000,
      startTriggers: ['action'],
      timeoutMs: 12000,
    },
    dependsOn: [],
    groupId: 'credentials',
    id: 'activate-vaultwarden',
    sections: [
      {
        field: field('Email', config.ownerEmail),
        id: 'copy-email',
        title: 'Copy your email',
      },
      {
        action: {
          href: `${config.appUrls.vaultwarden}/#/signup`,
          kind: 'link',
          label: 'Go to Vaultwarden signup',
        },
        id: 'create-admin-user',
        title: 'Set up your admin user',
      },
    ],
    summary:
      'Vaultwarden will be your new password manager. Create your user there first so you can receive and store the credentials for the rest of My Own Suite. We will automatically continue as soon as the suite detects your account.',
    title: 'Activate Vaultwarden',
  };

  const importSuiteCredentials: CurrentAction = {
    completion: {
      mode: 'automatic',
      source: completionSource.import,
    },
    detection: {
      actionSectionIds: ['open-import-screen'],
      pollIntervalMs: 1000,
      pollWhileActive: true,
      revealDelayMs: 1000,
      startTriggers: ['action'],
      timeoutMs: 12000,
    },
    dependsOn: ['activate-vaultwarden'],
    groupId: 'credentials',
    id: 'import-suite-credentials',
    sections: [
      {
        action: {
          href: `${config.appUrls.vaultwarden}/#/tools/import`,
          kind: 'link',
          label: 'Go to import page',
        },
        id: 'open-import-screen',
        title: 'Go to the import page',
      },
      {
        id: 'choose-csv',
        title: 'Set the file type to Bitwarden (csv)',
      },
      {
        action: {
          copyPath: '/api/onboarding/imports/vaultwarden.csv',
          kind: 'copy',
          label: 'Copy your suite credentials',
        },
        id: 'copy-import',
        title: 'Copy your suite credentials',
      },
      {
        action: {
          actionId: 'import-suite-credentials',
          kind: 'trigger',
          label: 'I have imported my credentials',
        },
        id: 'finish-import',
        title: 'Paste and import your credentials',
      },
    ],
    summary:
      "Great. You are now inside your new password manager. Now let's import the credentials for Suite Manager and the rest of your My Own Suite apps into Vaultwarden.",
    title: 'Import your suite credentials',
  };

  return [
    activateVaultwarden,
    importSuiteCredentials,
  ];
}
