import type { SuiteManagerConfig } from '../../../config.ts';
import type { OnboardingStep } from '../shared/types.ts';
import { buildRadicaleSteps } from '../radicale/steps.ts';
import { buildVaultwardenSteps } from '../vaultwarden/steps.ts';

export async function buildOnboardingSteps(
  config: SuiteManagerConfig,
  state: {
    radicaleConnected: boolean;
    suiteCredentialsImportSource: 'database' | 'manual' | 'none';
    suiteCredentialsImported: boolean;
    vaultwardenAccountSource: 'database' | 'manual' | 'none';
    vaultwardenAccountReady: boolean;
  },
): Promise<OnboardingStep[]> {
  const vaultwardenSteps = buildVaultwardenSteps(
    config,
    state.vaultwardenAccountReady,
    state.suiteCredentialsImported,
    {
      import: state.suiteCredentialsImportSource,
      vaultwardenAccount: state.vaultwardenAccountSource,
    },
  );
  const radicaleSteps = await buildRadicaleSteps(
    config,
    state.vaultwardenAccountReady && state.suiteCredentialsImported,
    state.radicaleConnected,
  );

  return [...vaultwardenSteps, ...radicaleSteps];
}
