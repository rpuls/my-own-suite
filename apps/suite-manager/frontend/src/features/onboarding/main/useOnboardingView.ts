import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  OnboardingModel,
  OnboardingSnackbarNotice,
  OnboardingStepGroup,
  OnboardingStep,
  OnboardingStepView,
  OnboardingViewModel,
  StepDetection,
  StepDetectionState,
} from '../shared/types';
import { useOnboarding } from './useOnboarding';

type StepSnapshot = {
  status: OnboardingStep['status'];
};

function buildProgress(groups: OnboardingStepGroup[], steps: OnboardingStep[]) {
  const totalSteps = steps.length;
  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const currentStepIndex = steps.findIndex((step) => step.status === 'active');

  return {
    completedSteps,
    currentStepIndex: currentStepIndex >= 0 ? currentStepIndex : null,
    percentComplete: totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0,
    sections: groups.map((group) => {
      const groupSteps = steps.filter((step) => step.groupId === group.id);
      return {
        completedSteps: groupSteps.filter((step) => step.status === 'completed').length,
        id: group.id,
        title: group.title,
        totalSteps: groupSteps.length,
      };
    }),
    totalSteps,
  };
}

function buildStepSnapshots(steps: OnboardingStep[]): Record<string, StepSnapshot> {
  return Object.fromEntries(
    steps.map((step) => [
      step.id,
      {
        status: step.status,
      },
    ]),
  );
}

function modelSignature(model: OnboardingModel): string {
  return JSON.stringify({
    currentStepId: model.currentStepId,
    steps: model.steps.map((step) => ({
      completionSource: step.completion.source,
      id: step.id,
      status: step.status,
    })),
  });
}

function getCurrentStep(model: OnboardingModel | null): OnboardingStep | null {
  if (!model?.currentStepId) {
    return null;
  }

  return model.steps.find((step) => step.id === model.currentStepId) ?? null;
}

function getDetectionConfig(step: OnboardingStep | null): StepDetection | null {
  if (!step || step.completion.mode !== 'automatic') {
    return null;
  }

  return step.detection ?? null;
}

function shouldDeferAutomaticStepCommit(
  currentModel: OnboardingModel | null,
  nextModel: OnboardingModel,
  armedDetectionStepId: string | null,
  detectingStepId: string | null,
): boolean {
  const currentStep = getCurrentStep(currentModel);
  const detection = getDetectionConfig(currentStep);

  if (!currentStep || !detection) {
    return false;
  }

  if (detectingStepId === currentStep.id) {
    return true;
  }

  if (armedDetectionStepId !== currentStep.id) {
    return false;
  }

  return modelSignature(nextModel) !== modelSignature(currentModel ?? nextModel);
}

export function useOnboardingView() {
  const { refreshModel, state } = useOnboarding();
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [detectingStepId, setDetectingStepId] = useState<string | null>(null);
  const [snackbarNotice, setSnackbarNotice] = useState<OnboardingSnackbarNotice | null>(null);
  const [presentedModel, setPresentedModel] = useState<OnboardingModel | null>(null);
  const [armedDetectionStepId, setArmedDetectionStepId] = useState<string | null>(null);
  const presentedModelRef = useRef<OnboardingModel | null>(null);
  const sourceModelRef = useRef<OnboardingModel | null>(null);
  const previousStepsRef = useRef<Record<string, StepSnapshot>>({});
  const snackbarTimerRef = useRef<number | null>(null);
  const expandedTransitionTimerRef = useRef<number | null>(null);
  const detectionRunIdRef = useRef(0);

  function commitPresentedModel(nextModel: OnboardingModel): void {
    const previousSteps = previousStepsRef.current;
    const nextActiveSteps = nextModel.steps.filter((step) => step.status === 'active');

    for (const step of nextModel.steps) {
      const previousStep = previousSteps[step.id];
      const becameAutoCompleted =
        previousStep?.status === 'active' &&
        step.status === 'completed' &&
        step.completion.mode === 'automatic' &&
        step.completion.source !== 'none';

      if (!becameAutoCompleted) {
        continue;
      }

      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current);
      }

      setSnackbarNotice({
        message: `Completed: ${step.title}`,
        stepId: step.id,
      });

      snackbarTimerRef.current = window.setTimeout(() => {
        setSnackbarNotice((current) => (current?.stepId === step.id ? null : current));
      }, 2800);
    }

    previousStepsRef.current = buildStepSnapshots(nextModel.steps);
    presentedModelRef.current = nextModel;
    setPresentedModel(nextModel);
    setExpandedStepId((currentExpanded) => {
      const expandedStepBecameCompleted =
        Boolean(currentExpanded) &&
        nextModel.steps.some((step) => {
          const previousStep = previousSteps[step.id];
          return (
            step.id === currentExpanded &&
            previousStep?.status === 'active' &&
            step.status === 'completed' &&
            step.completion.mode === 'automatic' &&
            step.completion.source !== 'none'
          );
        });

      if (expandedStepBecameCompleted) {
        if (expandedTransitionTimerRef.current !== null) {
          window.clearTimeout(expandedTransitionTimerRef.current);
        }

        expandedTransitionTimerRef.current = window.setTimeout(() => {
          setExpandedStepId(nextActiveSteps.length === 1 ? nextActiveSteps[0].id : null);
          expandedTransitionTimerRef.current = null;
        }, 850);

        return currentExpanded;
      }

      if (currentExpanded && nextModel.steps.some((step) => step.id === currentExpanded && step.status !== 'locked')) {
        return currentExpanded;
      }

      return nextModel.currentStepId;
    });
    setArmedDetectionStepId((current) => (current && current !== nextModel.currentStepId ? null : current));
  }

  async function runDetection(stepId: string, detection: StepDetection): Promise<void> {
    const runId = ++detectionRunIdRef.current;
    const revealReadyAt = Date.now() + detection.revealDelayMs;
    const giveUpAt = Date.now() + detection.timeoutMs;
    const settleTimer = window.setTimeout(() => {
      if (detectionRunIdRef.current === runId) {
        setDetectingStepId((current) => (current === stepId ? null : current));
      }
    }, detection.revealDelayMs);

    setDetectingStepId(stepId);

    try {
      while (detectionRunIdRef.current === runId) {
        const presented = presentedModelRef.current;
        const source = sourceModelRef.current;

        if (presented && source && modelSignature(source) !== modelSignature(presented)) {
          const waitMs = Math.max(0, revealReadyAt - Date.now());

          if (document.visibilityState !== 'visible') {
            setDetectingStepId((current) => (current === stepId ? null : current));
            return;
          }

          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, waitMs);
          });

          if (detectionRunIdRef.current !== runId) {
            return;
          }

          commitPresentedModel(source);
          setDetectingStepId(null);
          return;
        }

        if (Date.now() >= giveUpAt) {
          setDetectingStepId((current) => (current === stepId ? null : current));
          return;
        }

        try {
          const nextModel = await refreshModel();
          sourceModelRef.current = nextModel;
        } catch {
          setDetectingStepId((current) => (current === stepId ? null : current));
          return;
        }

        const latestPresented = presentedModelRef.current;
        if (latestPresented?.currentStepId !== stepId) {
          setDetectingStepId((current) => (current === stepId ? null : current));
          return;
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, detection.pollIntervalMs);
        });
      }
    } finally {
      window.clearTimeout(settleTimer);
    }
  }

  function startDetectionForStep(stepId: string): void {
    const currentModel = presentedModelRef.current;
    const currentStep = getCurrentStep(currentModel);

    if (!currentStep || currentStep.id !== stepId) {
      return;
    }

    const detection = getDetectionConfig(currentStep);
    if (!detection) {
      return;
    }

    void runDetection(stepId, detection);
  }

  function notifyStepAction(stepId: string, sectionId: string): void {
    const currentStep = getCurrentStep(presentedModelRef.current);

    if (!currentStep || currentStep.id !== stepId) {
      return;
    }

    const detection = getDetectionConfig(currentStep);
    if (!detection?.actionSectionIds?.includes(sectionId)) {
      return;
    }

    setArmedDetectionStepId(stepId);
  }

  useEffect(() => {
    return () => {
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current);
      }

      if (expandedTransitionTimerRef.current !== null) {
        window.clearTimeout(expandedTransitionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'loaded') {
      return;
    }

    sourceModelRef.current = state.model;

    if (!presentedModelRef.current) {
      previousStepsRef.current = buildStepSnapshots(state.model.steps);
      presentedModelRef.current = state.model;
      setPresentedModel(state.model);
      setExpandedStepId(state.model.currentStepId);
      return;
    }

    if (
      shouldDeferAutomaticStepCommit(presentedModelRef.current, state.model, armedDetectionStepId, detectingStepId)
    ) {
      return;
    }

    if (modelSignature(state.model) !== modelSignature(presentedModelRef.current)) {
      commitPresentedModel(state.model);
    }
  }, [armedDetectionStepId, detectingStepId, state]);

  useEffect(() => {
    const currentStep = getCurrentStep(presentedModel);
    const detection = getDetectionConfig(currentStep);

    if (!currentStep || !detection?.pollWhileActive) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void refreshModel()
        .then((nextModel) => {
          sourceModelRef.current = nextModel;
        })
        .catch(() => undefined);
    }, detection.pollIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [presentedModel, refreshModel]);

  useEffect(() => {
    function maybeResumeDetection(): void {
      if (document.visibilityState !== 'visible') {
        return;
      }

      const currentStep = getCurrentStep(presentedModelRef.current);
      const detection = getDetectionConfig(currentStep);

      if (!currentStep || !detection) {
        return;
      }

      const isActionArmed = armedDetectionStepId === currentStep.id && detection.startTriggers.includes('action');
      const isFocusTriggered = detection.startTriggers.includes('focus');

      if (!isActionArmed && !isFocusTriggered) {
        return;
      }

      startDetectionForStep(currentStep.id);
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState !== 'visible') {
        return;
      }

      maybeResumeDetection();
    }

    function handleWindowFocus(): void {
      maybeResumeDetection();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [armedDetectionStepId]);

  const view = useMemo<OnboardingViewModel | null>(() => {
    if (!presentedModel) {
      return null;
    }

    const stepViews: OnboardingStepView[] = presentedModel.steps.map((step) => {
      let detectionState: StepDetectionState = null;

      if (detectingStepId === step.id) {
        detectionState = 'detecting';
      } else if (snackbarNotice?.stepId === step.id) {
        detectionState = 'completed';
      }

      return {
        ...step,
        detectionState,
      };
    });

    return {
      currentStepId: presentedModel.currentStepId,
      groups: presentedModel.groups,
      homepageUrl: presentedModel.homepageUrl,
      observations: presentedModel.observations,
      owner: presentedModel.owner,
      progress: buildProgress(presentedModel.groups, presentedModel.steps),
      snackbarNotice,
      steps: stepViews,
      title: presentedModel.title,
    };
  }, [detectingStepId, presentedModel, snackbarNotice]);

  return {
    expandedStepId,
    isUiSettling: Boolean(detectingStepId),
    notifyStepAction,
    refreshModel,
    setExpandedStepId,
    state,
    view,
  };
}
