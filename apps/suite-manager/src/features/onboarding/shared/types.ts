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
  completion: StepCompletion;
  detection?: StepDetection;
  dependsOn: string[];
  groupId: OnboardingStepGroupId;
  id: string;
  sections: CurrentActionSection[];
  summary: string;
  title: string;
};

export type StepCompletion = {
  mode: 'automatic' | 'manual';
  source: 'database' | 'manual' | 'none';
};

export type StepDetection = {
  actionSectionIds?: string[];
  pollIntervalMs: number;
  pollWhileActive: boolean;
  revealDelayMs: number;
  startTriggers: Array<'action' | 'focus'>;
  timeoutMs: number;
};

export type OnboardingStepStatus = 'active' | 'completed' | 'locked';

export type OnboardingStepGroupId = 'applications' | 'credentials';

export type OnboardingStepGroup = {
  description: string;
  id: OnboardingStepGroupId;
  title: string;
};

export type OnboardingStep = CurrentAction & {
  status: OnboardingStepStatus;
};

export type OnboardingObservation = {
  importedCredentialCount: number | null;
  importStatus: 'blocked' | 'completed' | 'ready';
  importStatusSource: 'database' | 'manual' | 'none';
  observedImportTargetCount: number;
  vaultwardenAccountStatus: 'pending' | 'ready' | 'unavailable';
};

export type OnboardingModel = {
  currentAction: CurrentAction | null;
  currentStepId: string | null;
  generatedAt: string;
  groups: OnboardingStepGroup[];
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
  vaultwardenImportBaselineCipherCount: number | null;
  completedSteps: string[];
  updatedAt: string | null;
};
