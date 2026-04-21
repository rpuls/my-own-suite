import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction, OnboardingStep, OnboardingStepGroup } from '../shared/types.ts';
import { buildImmichSteps } from '../immich/steps.ts';
import { buildRadicaleSteps } from '../radicale/steps.ts';
import { buildSeafileSteps } from '../seafile/steps.ts';
import { buildVaultwardenSteps } from '../vaultwarden/steps.ts';

const onboardingGroups: OnboardingStepGroup[] = [
  {
    description: "First let's secure the credentials that power the rest of your suite.",
    id: 'credentials',
    title: 'Credentials',
  },
  {
    description: 'Start with what matters most to you. You can always come back and finish the rest later.',
    id: 'applications',
    title: 'Application setup & migration',
  },
];

function resolveStepStatuses(stepDefinitions: CurrentAction[]): OnboardingStep[] {
  const completedStepIds = new Set(
    stepDefinitions
      .filter((step) => step.completion.source !== 'none')
      .map((step) => step.id),
  );

  return stepDefinitions.map((step) => ({
    ...step,
    status:
      step.completion.source !== 'none'
        ? 'completed'
        : step.dependsOn.every((stepId) => completedStepIds.has(stepId))
          ? 'active'
          : 'locked',
  }));
}

export async function buildOnboardingSteps(
  config: SuiteManagerConfig,
  state: {
    immichReady: boolean;
    radicaleConnected: boolean;
    seafileReady: boolean;
    suiteCredentialsImportSource: 'database' | 'manual' | 'none';
    suiteCredentialsImported: boolean;
    vaultwardenAccountSource: 'database' | 'manual' | 'none';
    vaultwardenAccountReady: boolean;
  },
): Promise<{ groups: OnboardingStepGroup[]; steps: OnboardingStep[] }> {
  const stepDefinitions = [
    ...buildVaultwardenSteps(
      config,
      state.vaultwardenAccountReady,
      state.suiteCredentialsImported,
      {
        import: state.suiteCredentialsImportSource,
        vaultwardenAccount: state.vaultwardenAccountSource,
      },
    ),
    ...(await buildRadicaleSteps(config, state.radicaleConnected)),
    ...buildSeafileSteps(config, state.seafileReady),
    ...buildImmichSteps(config, state.immichReady),
  ];

  return {
    groups: onboardingGroups,
    steps: resolveStepStatuses(stepDefinitions),
  };
}
