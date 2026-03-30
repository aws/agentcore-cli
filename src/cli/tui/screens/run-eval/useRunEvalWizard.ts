import type { RunEvalConfig, RunEvalStep } from './types';
import { DEFAULT_LOOKBACK_DAYS } from './types';
import { useCallback, useState } from 'react';

function getAllSteps(agentCount: number): RunEvalStep[] {
  const steps: RunEvalStep[] = [];
  if (agentCount > 1) {
    steps.push('agent');
  }
  steps.push('evaluators', 'days', 'sessions');
  // groundTruth step is always in the array; setSessions skips it when multiple sessions selected
  steps.push('groundTruth');
  steps.push('confirm');
  return steps;
}

function getDefaultConfig(): RunEvalConfig {
  return {
    agent: '',
    evaluators: [],
    days: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
    assertions: [],
    expectedTrajectory: [],
    expectedResponse: '',
  };
}

export interface GroundTruthData {
  assertions: string[];
  expectedTrajectory: string[];
  expectedResponse: string;
}

export function useRunEvalWizard(agentCount: number) {
  const allSteps = getAllSteps(agentCount);
  const [config, setConfig] = useState<RunEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<RunEvalStep>(allSteps[0]!);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    if (step === 'confirm' && config.sessionIds.length !== 1) {
      // Skip GT step when going back from confirm with multiple sessions
      setStep('sessions');
      return;
    }
    const prevStep = allSteps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, currentIndex, step, config.sessionIds.length, setStep]);

  const nextStep = useCallback(
    (currentStep: RunEvalStep): RunEvalStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      return allSteps[idx + 1];
    },
    [allSteps]
  );

  const setAgent = useCallback(
    (agent: string) => {
      setConfig(c => ({ ...c, agent }));
      const next = nextStep('agent');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setEvaluators = useCallback(
    (evaluators: string[]) => {
      setConfig(c => ({ ...c, evaluators }));
      const next = nextStep('evaluators');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setDays = useCallback(
    (days: number) => {
      setConfig(c => ({ ...c, days }));
      const next = nextStep('days');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setSessions = useCallback(
    (sessionIds: string[]) => {
      if (sessionIds.length === 1) {
        // Single session: go to ground truth
        setConfig(c => ({ ...c, sessionIds }));
        setStep('groundTruth');
      } else {
        // Multiple sessions: skip GT, clear any stale GT data
        setConfig(c => ({
          ...c,
          sessionIds,
          assertions: [],
          expectedTrajectory: [],
          expectedResponse: '',
        }));
        setStep('confirm');
      }
    },
    [setConfig, setStep]
  );

  const setGroundTruth = useCallback(
    (gt: GroundTruthData) => {
      setConfig(c => ({ ...c, ...gt }));
      setStep('confirm');
    },
    [setConfig, setStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep(allSteps[0]!);
  }, [allSteps, setConfig, setStep]);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    goBack,
    setAgent,
    setEvaluators,
    setDays,
    setSessions,
    setGroundTruth,
    reset,
  };
}
