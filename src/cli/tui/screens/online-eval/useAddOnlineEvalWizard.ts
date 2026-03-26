import type { AddOnlineEvalConfig, AddOnlineEvalStep } from './types';
import { DEFAULT_SAMPLING_RATE } from './types';
import { useCallback, useState } from 'react';

function getAllSteps(agentCount: number): AddOnlineEvalStep[] {
  if (agentCount <= 1) {
    return ['name', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
  }
  return ['name', 'agent', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
}

function getDefaultConfig(): AddOnlineEvalConfig {
  return {
    name: '',
    agent: '',
    evaluators: [],
    samplingRate: DEFAULT_SAMPLING_RATE,
    enableOnCreate: true,
  };
}

export function useAddOnlineEvalWizard(agentCount: number) {
  const allSteps = getAllSteps(agentCount);
  const [config, setConfig] = useState<AddOnlineEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddOnlineEvalStep>(allSteps[0]!);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = allSteps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, currentIndex, setStep]);

  const nextStep = useCallback(
    (currentStep: AddOnlineEvalStep): AddOnlineEvalStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      return allSteps[idx + 1];
    },
    [allSteps]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
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

  const setSamplingRate = useCallback(
    (samplingRate: number) => {
      setConfig(c => ({ ...c, samplingRate }));
      const next = nextStep('samplingRate');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setEnableOnCreate = useCallback(
    (enableOnCreate: boolean) => {
      setConfig(c => ({ ...c, enableOnCreate }));
      const next = nextStep('enableOnCreate');
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
    setName,
    setAgent,
    setEvaluators,
    setSamplingRate,
    setEnableOnCreate,
    reset,
  };
}
