import type { SuiteManagerConfig } from '../../../config.ts';
import type { PersistedState } from '../shared/types.ts';
import { OnboardingStateStore } from '../shared/state-store.ts';
import type { OnboardingModel } from '../shared/types.ts';
import { buildOnboardingSteps } from './steps.ts';
import { VaultwardenObserver } from '../vaultwarden/observer.ts';

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
    const radicaleConnected = state.completedSteps.includes('connect-radicale');
    const steps = await buildOnboardingSteps(this.config, authorized, {
      radicaleConnected,
      suiteCredentialsImported,
      vaultwardenAccountReady,
    });
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

    if (actionId === 'connect-radicale') {
      return this.stateStore.update('connect-radicale', true);
    }

    throw new Error(`Unknown action: ${actionId}`);
  }
}
