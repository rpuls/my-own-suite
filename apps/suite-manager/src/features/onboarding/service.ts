import type { SuiteManagerConfig } from '../../config.ts';
import { presentValue } from '../../lib/secrets.ts';
import { OnboardingStateStore } from './state-store.ts';
import type {
  ActionField,
  CurrentAction,
  OnboardingModel,
  OnboardingStep,
  PersistedState,
} from './types.ts';
import { VaultwardenObserver, type VaultwardenAccountStatus } from './vaultwarden-observer.ts';

function field(label: string, value: string, authorized: boolean, secret = false): ActionField {
  return {
    label,
    secret,
    value: presentValue(value, authorized, secret),
  };
}

export class OnboardingService {
  private readonly config: SuiteManagerConfig;
  private readonly stateStore: OnboardingStateStore;
  private readonly vaultwardenObserver: VaultwardenObserver;

  constructor(
    config: SuiteManagerConfig,
    stateStore: OnboardingStateStore,
    vaultwardenObserver: VaultwardenObserver,
  ) {
    this.config = config;
    this.stateStore = stateStore;
    this.vaultwardenObserver = vaultwardenObserver;
  }

  getStateFilePath(): string {
    return this.stateStore.getStateFilePath();
  }

  async buildModel(authorized: boolean): Promise<OnboardingModel> {
    const state = this.stateStore.load();
    const vaultwardenObservation = await this.vaultwardenObserver.getAccountStatus();
    const vaultwardenAccountReady = vaultwardenObservation.status === 'ready';
    const suiteCredentialsImported = state.completedSteps.includes('import-generated-accounts');
    const steps = this.getSteps(authorized, vaultwardenAccountReady, suiteCredentialsImported);
    const currentAction = steps.find((step) => step.status === 'active') ?? null;

    return {
      authorized,
      currentAction,
      currentStepId: currentAction?.id ?? null,
      generatedAt: new Date().toISOString(),
      observations: {
        importStatus: suiteCredentialsImported ? 'completed' : vaultwardenAccountReady ? 'ready' : 'blocked',
        vaultwardenAccountStatus: vaultwardenObservation.status,
      },
      owner: {
        email: this.config.ownerEmail,
        name: this.config.ownerName,
      },
      requiresToken: Boolean(this.config.bootstrapToken),
      steps,
      title: 'My Own Suite Setup',
    };
  }

  triggerAction(actionId: string): PersistedState {
    if (actionId === 'import-suite-credentials') {
      return this.stateStore.update('import-generated-accounts', true);
    }

    throw new Error(`Unknown action: ${actionId}`);
  }

  private getSteps(
    authorized: boolean,
    vaultwardenAccountReady: boolean,
    suiteCredentialsImported: boolean,
  ): OnboardingStep[] {
    const activateVaultwarden: CurrentAction = {
      id: 'activate-vaultwarden',
      sections: [
        {
          field: field('Email', this.config.ownerEmail, authorized),
          id: 'copy-email',
          title: 'Copy your email',
        },
        {
          action: {
            href: `${this.config.appUrls.vaultwarden}/#/signup`,
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
              href: `${this.config.appUrls.vaultwarden}/#/tools/import`,
              kind: 'link',
              label: 'Go to import page',
            },
            id: 'open-import-screen',
            title: 'Go to the import page',
          },
          {
            id: 'choose-csv',
            title: 'Set the file type to CSV',
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

    const continueWithApps: CurrentAction = {
      id: 'next-phase',
      sections: [],
      summary:
        'Your Vaultwarden account is ready and your suite credentials have been handed off. The next onboarding phase can now focus on app-specific setup that truly needs your input.',
      title: 'Step 3: Continue With App Setup',
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
      {
        ...continueWithApps,
        status: !vaultwardenAccountReady || !suiteCredentialsImported ? 'locked' : 'active',
      },
    ];
  }
}
