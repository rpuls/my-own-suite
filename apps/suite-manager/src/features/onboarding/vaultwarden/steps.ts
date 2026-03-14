import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction, OnboardingStep } from '../shared/types.ts';

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
): OnboardingStep[] {
  const activateVaultwarden: CurrentAction = {
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
    title: 'Step 1: Activate Vaultwarden',
  };

  const importSuiteCredentials: CurrentAction = {
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
          label: 'Copy your credentials',
        },
        id: 'copy-import',
        title: 'Copy your credentials',
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
      'Great. You are now inside your new password manager. We have already created accounts for you in the other My Own Suite apps. Now let’s import those credentials into Vaultwarden.',
    title: 'Step 2: Securely Import Your Suite Credentials',
  };

  return [
    {
      ...activateVaultwarden,
      status: vaultwardenAccountReady ? 'completed' : 'active',
    },
    {
      ...importSuiteCredentials,
      status: !vaultwardenAccountReady ? 'locked' : suiteCredentialsImported ? 'completed' : 'active',
    },
  ];
}
