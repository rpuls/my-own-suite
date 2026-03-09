export type ActionField = {
  label: string;
  secret?: boolean;
  value: string;
};

export type CurrentActionButton = {
  actionId?: string;
  copyPath?: string;
  downloadPath?: string;
  href?: string;
  kind: 'copy' | 'download' | 'link' | 'trigger';
  label: string;
};

export type CurrentActionSection = {
  action?: CurrentActionButton;
  field?: ActionField;
  id: string;
  title: string;
};

export type CurrentAction = {
  id: string;
  sections: CurrentActionSection[];
  summary: string;
  title: string;
};

export type OnboardingStepStatus = 'active' | 'completed' | 'locked';

export type OnboardingStep = CurrentAction & {
  status: OnboardingStepStatus;
};

export type OnboardingObservation = {
  importStatus: 'blocked' | 'completed' | 'ready';
  vaultwardenAccountStatus: 'pending' | 'ready' | 'unavailable';
};

export type OnboardingModel = {
  authorized: boolean;
  currentAction: CurrentAction | null;
  currentStepId: string | null;
  generatedAt: string;
  observations: OnboardingObservation;
  owner: {
    email: string;
    name: string;
  };
  requiresToken: boolean;
  steps: OnboardingStep[];
  title: string;
};

export type PersistedState = {
  completedSteps: string[];
  updatedAt: string | null;
};
