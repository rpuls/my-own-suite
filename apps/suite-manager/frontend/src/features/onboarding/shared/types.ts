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

export type StepDetectionState = 'completed' | 'detecting' | null;

export type OnboardingStepStatus = 'active' | 'completed' | 'locked';

export type OnboardingStep = CurrentAction & {
  status: OnboardingStepStatus;
};

export type OnboardingStepView = OnboardingStep & {
  detectionState: StepDetectionState;
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
  homepageUrl: string;
  observations: OnboardingObservation;
  owner: {
    email: string;
    name: string;
  };
  steps: OnboardingStep[];
  title: string;
};

export type OnboardingProgress = {
  completedSteps: number;
  currentStepIndex: number | null;
  percentComplete: number;
  totalSteps: number;
};

export type OnboardingSnackbarNotice = {
  message: string;
  stepId: string;
};

export type OnboardingViewModel = {
  currentStepId: string | null;
  homepageUrl: string;
  observations: OnboardingObservation;
  owner: OnboardingModel['owner'];
  progress: OnboardingProgress;
  snackbarNotice: OnboardingSnackbarNotice | null;
  steps: OnboardingStepView[];
  title: string;
};
