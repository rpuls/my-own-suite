export type ActionField = {
  label: string;
  qrAlt?: string;
  qrValue?: string;
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

export type ActionQrCode = {
  alt: string;
  caption?: string;
  src: string;
};

export type CurrentActionSection = {
  action?: CurrentActionButton;
  description?: string;
  field?: ActionField;
  id: string;
  qrCode?: ActionQrCode;
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
  currentAction: CurrentAction | null;
  currentStepId: string | null;
  generatedAt: string;
  homepageUrl: string;
  observations: OnboardingObservation;
  owner: {
    email: string;
    name: string;
  };
  steps: OnboardingStep[];
  title: string;
};

export type PersistedState = {
  completedSteps: string[];
  updatedAt: string | null;
};
