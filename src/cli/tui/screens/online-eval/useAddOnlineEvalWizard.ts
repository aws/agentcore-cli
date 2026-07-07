import type { AddOnlineEvalConfig, AddOnlineEvalStep, OnlineEvalSource } from './types';
import { DEFAULT_SAMPLING_RATE } from './types';
import { useCallback, useRef, useState } from 'react';

function getAllSteps(agentCount: number): AddOnlineEvalStep[] {
  if (agentCount <= 1) {
    // endpoint step is included but will be skipped dynamically when no endpoints exist
    // source step routes to either agent/endpoint OR logGroupNames/serviceName
    return [
      'name',
      'source',
      'endpoint',
      'logGroupNames',
      'serviceName',
      'evaluators',
      'samplingRate',
      'enableOnCreate',
      'confirm',
    ];
  }
  return [
    'name',
    'source',
    'agent',
    'endpoint',
    'logGroupNames',
    'serviceName',
    'evaluators',
    'samplingRate',
    'enableOnCreate',
    'confirm',
  ];
}

function getDefaultConfig(): AddOnlineEvalConfig {
  return {
    name: '',
    agent: '',
    endpoint: undefined,
    logGroupNames: undefined,
    serviceNames: undefined,
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
  const [source, setSourceState] = useState<OnlineEvalSource>('agentcore-runtime');
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

  const setSource = useCallback(
    (selectedSource: OnlineEvalSource) => {
      setSourceState(selectedSource);
      // Reset fields based on source selection
      if (selectedSource === 'cloudwatch-logs') {
        setConfig(c => ({ ...c, agent: '', endpoint: undefined, logGroupNames: undefined, serviceNames: undefined }));
      } else {
        setConfig(c => ({ ...c, logGroupNames: undefined, serviceNames: undefined }));
      }
      const next = nextStep('source');
      if (next) setStep(next);
    },
    [nextStep, setSourceState, setConfig, setStep]
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

  const setLogGroupNames = useCallback(
    (logGroupNames: string[]) => {
      setConfig(c => ({ ...c, logGroupNames }));
      const next = nextStep('logGroupNames');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setServiceNames = useCallback(
    (serviceNames: string[]) => {
      setConfig(c => ({ ...c, serviceNames: serviceNames.length > 0 ? serviceNames : undefined }));
      const next = nextStep('serviceName');
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
    setSourceState('agentcore-runtime');
    setStep(allSteps[0]!);
  }, [allSteps, setSourceState, setConfig, setStep]);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    source,
    goBack,
    setSkipCheck,
    setName,
    setSource,
    setAgent,
    setEndpoint,
    setLogGroupNames,
    setServiceNames,
    setEvaluators,
    setSamplingRate,
    setEnableOnCreate,
    reset,
  };
}
