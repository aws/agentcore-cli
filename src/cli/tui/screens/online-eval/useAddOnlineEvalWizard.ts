import type { AddOnlineEvalConfig, AddOnlineEvalStep } from './types';
import { DEFAULT_SAMPLING_RATE } from './types';
import { useCallback, useRef, useState } from 'react';

function getAllSteps(agentCount: number): AddOnlineEvalStep[] {
  if (agentCount <= 1) {
    // endpoint step is included but will be skipped dynamically when no endpoints exist
    return ['name', 'endpoint', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
  }
  return ['name', 'agent', 'endpoint', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
}

function getDefaultConfig(): AddOnlineEvalConfig {
  return {
    name: '',
    agent: '',
    endpoint: undefined,
    evaluators: [],
    samplingRate: DEFAULT_SAMPLING_RATE,
    enableOnCreate: true,
  };
}

type StepSkipCheck = (step: AddOnlineEvalStep) => boolean;

export function useAddOnlineEvalWizard(agentCount: number) {
  const allSteps = getAllSteps(agentCount);
  const [config, setConfig] = useState<AddOnlineEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddOnlineEvalStep>(allSteps[0]!);
  const skipCheckRef = useRef<StepSkipCheck>(() => false);

  const currentIndex = allSteps.indexOf(step);

  const setSkipCheck = useCallback((check: StepSkipCheck) => {
    skipCheckRef.current = check;
  }, []);

  const goBack = useCallback(() => {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (!skipCheckRef.current(allSteps[i]!)) {
        setStep(allSteps[i]!);
        return;
      }
    }
  }, [allSteps, currentIndex, setStep]);

  const nextStep = useCallback(
    (currentStep: AddOnlineEvalStep): AddOnlineEvalStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      for (let i = idx + 1; i < allSteps.length; i++) {
        if (!skipCheckRef.current(allSteps[i]!)) {
          return allSteps[i]!;
        }
      }
      return undefined;
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
      setConfig(c => ({ ...c, agent, endpoint: undefined }));
      const next = nextStep('agent');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setEndpoint = useCallback(
    (endpoint: string | undefined) => {
      setConfig(c => ({ ...c, endpoint }));
      const next = nextStep('endpoint');
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
    setSkipCheck,
    setName,
    setAgent,
    setEndpoint,
    setEvaluators,
    setSamplingRate,
    setEnableOnCreate,
    reset,
  };
}
