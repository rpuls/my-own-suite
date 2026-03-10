import type { SuiteManagerConfig } from '../../../config.ts';
import type { OnboardingStep } from '../shared/types.ts';
import { buildRadicaleSteps } from '../radicale/steps.ts';
import { buildVaultwardenSteps } from '../vaultwarden/steps.ts';

export async function buildOnboardingSteps(
  config: SuiteManagerConfig,
  authorized: boolean,
  state: {
    radicaleConnected: boolean;
    suiteCredentialsImported: boolean;
    vaultwardenAccountReady: boolean;
  },
): Promise<OnboardingStep[]> {
  const vaultwardenSteps = buildVaultwardenSteps(
    config,
    authorized,
    state.vaultwardenAccountReady,
    state.suiteCredentialsImported,
  );
  const radicaleSteps = await buildRadicaleSteps(
    config,
    authorized,
    state.vaultwardenAccountReady && state.suiteCredentialsImported,
    state.radicaleConnected,
  );

  return [...vaultwardenSteps, ...radicaleSteps];
}
