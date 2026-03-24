import type { SuiteManagerConfig } from '../../../config.ts';
import type { PersistedState } from '../shared/types.ts';
import { OnboardingStateStore } from '../shared/state-store.ts';
import type { OnboardingModel } from '../shared/types.ts';
import { buildOnboardingSteps } from './steps.ts';
import { getVaultwardenImportEntries } from '../vaultwarden/import-handoff.ts';
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

  private getExpectedVaultwardenImportCount(): number {
    return getVaultwardenImportEntries(this.config).length;
  }

  async buildModel(): Promise<OnboardingModel> {
    let state = this.stateStore.load();
    const vaultwardenObservation = await this.vaultwardenObserver.getAccountStatus();
    const vaultwardenAccountReady = vaultwardenObservation.status === 'ready';
    const expectedImportCount = this.getExpectedVaultwardenImportCount();
    const importedByManualAction = state.completedSteps.includes('import-generated-accounts');
    const currentCipherCount = vaultwardenObservation.cipherCount;
    const baselineCipherCount = state.vaultwardenImportBaselineCipherCount;
    const shouldPersistBaseline =
      vaultwardenAccountReady &&
      currentCipherCount !== null &&
      baselineCipherCount === null &&
      !importedByManualAction;

    if (shouldPersistBaseline) {
      const inferredBaseline = currentCipherCount >= expectedImportCount ? 0 : currentCipherCount;
      state = this.stateStore.updateVaultwardenImportBaseline(inferredBaseline);
    }

    const effectiveBaselineCipherCount =
      shouldPersistBaseline && currentCipherCount !== null
        ? currentCipherCount >= expectedImportCount
          ? 0
          : currentCipherCount
        : state.vaultwardenImportBaselineCipherCount;
    const importedByDatabase =
      expectedImportCount > 0 &&
      vaultwardenAccountReady &&
      currentCipherCount !== null &&
      effectiveBaselineCipherCount !== null &&
      currentCipherCount >= effectiveBaselineCipherCount + expectedImportCount;
    const suiteCredentialsImported = importedByManualAction || importedByDatabase;
    const suiteCredentialsImportSource = importedByDatabase ? 'database' : importedByManualAction ? 'manual' : 'none';
    const vaultwardenAccountSource = vaultwardenAccountReady ? 'database' : 'none';

    if (importedByDatabase && !importedByManualAction) {
      state = this.stateStore.update('import-generated-accounts', true);
    }

    const radicaleConnected = state.completedSteps.includes('connect-radicale');
    const steps = await buildOnboardingSteps(this.config, {
      radicaleConnected,
      suiteCredentialsImportSource,
      suiteCredentialsImported,
      vaultwardenAccountSource,
      vaultwardenAccountReady,
    });
    const currentAction = steps.find((step) => step.status === 'active') ?? null;

    return {
      currentAction,
      currentStepId: currentAction?.id ?? null,
      generatedAt: new Date().toISOString(),
      homepageUrl: '/',
      observations: {
        importedCredentialCount: currentCipherCount,
        importStatus: suiteCredentialsImported ? 'completed' : vaultwardenAccountReady ? 'ready' : 'blocked',
        importStatusSource: suiteCredentialsImportSource,
        observedImportTargetCount: expectedImportCount,
        vaultwardenAccountStatus: vaultwardenObservation.status,
      },
      owner: {
        email: this.config.ownerEmail,
        name: this.config.ownerName,
      },
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
