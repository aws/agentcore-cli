import type { RunEvalConfig, RunEvalStep } from './types';
import { DEFAULT_LOOKBACK_DAYS } from './types';
import { useCallback, useState } from 'react';

function getAllSteps(agentCount: number): RunEvalStep[] {
  if (agentCount <= 1) {
    return ['evaluators', 'days', 'sessions', 'confirm'];
  }
  return ['agent', 'evaluators', 'days', 'sessions', 'confirm'];
}

function getDefaultConfig(): RunEvalConfig {
  return {
    agent: '',
    evaluators: [],
    days: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
  };
}

export function useRunEvalWizard(agentCount: number) {
  const allSteps = getAllSteps(agentCount);
  const [config, setConfig] = useState<RunEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<RunEvalStep>(allSteps[0]!);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = allSteps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, currentIndex, setStep]);

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
      setConfig(c => ({ ...c, sessionIds }));
      const next = nextStep('sessions');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
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
    reset,
  };
}
