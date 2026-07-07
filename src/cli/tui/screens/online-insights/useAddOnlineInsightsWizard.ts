import type { AddOnlineInsightsConfig, AddOnlineInsightsStep } from './types';
import { DEFAULT_INSIGHTS_SAMPLING_RATE } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddOnlineInsightsStep[] = ['agent', 'insights', 'samplingRate', 'clustering', 'name', 'confirm'];

function getDefaultConfig(): AddOnlineInsightsConfig {
  return {
    name: '',
    agent: '',
    insights: [],
    samplingRate: DEFAULT_INSIGHTS_SAMPLING_RATE,
    clusteringFrequencies: [],
    enableOnCreate: true,
  };
}

export function useAddOnlineInsightsWizard() {
  const allSteps = ALL_STEPS;
  const [config, setConfig] = useState<AddOnlineInsightsConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddOnlineInsightsStep>(allSteps[0]!);

  const currentIndex = allSteps.indexOf(step);

  const nextStep = useCallback(
    (currentStep: AddOnlineInsightsStep): AddOnlineInsightsStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      if (idx + 1 < allSteps.length) {
        return allSteps[idx + 1]!;
      }
      return undefined;
    },
    [allSteps]
  );

  const goBack = useCallback(() => {
    for (let i = currentIndex - 1; i >= 0; i--) {
      setStep(allSteps[i]!);
      return;
    }
  }, [allSteps, currentIndex, setStep]);

  const setAgent = useCallback(
    (agent: string) => {
      setConfig(c => ({ ...c, agent }));
      const next = nextStep('agent');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setInsights = useCallback(
    (insights: string[]) => {
      setConfig(c => ({ ...c, insights }));
      const next = nextStep('insights');
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

  const setClusteringFrequencies = useCallback(
    (clusteringFrequencies: string[]) => {
      setConfig(c => ({ ...c, clusteringFrequencies }));
      const next = nextStep('clustering');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
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
    setInsights,
    setSamplingRate,
    setClusteringFrequencies,
    setName,
    reset,
  };
}
