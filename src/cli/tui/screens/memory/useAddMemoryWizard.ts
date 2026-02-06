import type { MemoryStrategyType } from '../../../../schema';
import type { AddMemoryConfig, AddMemoryStep, AddMemoryStrategyConfig } from './types';
import { DEFAULT_EVENT_EXPIRY } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddMemoryStep[] = ['name', 'expiry', 'strategies', 'confirm'];

function getDefaultConfig(): AddMemoryConfig {
  return {
    name: '',
    eventExpiryDuration: DEFAULT_EVENT_EXPIRY,
    strategies: [],
  };
}

export function useAddMemoryWizard() {
  const [config, setConfig] = useState<AddMemoryConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddMemoryStep>('name');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex]);

  const nextStep = useCallback((currentStep: AddMemoryStep): AddMemoryStep | undefined => {
    const idx = ALL_STEPS.indexOf(currentStep);
    return ALL_STEPS[idx + 1];
  }, []);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setExpiry = useCallback(
    (eventExpiryDuration: number) => {
      setConfig(c => ({ ...c, eventExpiryDuration }));
      const next = nextStep('expiry');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setStrategyTypes = useCallback(
    (types: MemoryStrategyType[]) => {
      const strategies: AddMemoryStrategyConfig[] = types.map(type => ({ type }));
      setConfig(c => ({ ...c, strategies }));
      const next = nextStep('strategies');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps: ALL_STEPS,
    currentIndex,
    goBack,
    setName,
    setExpiry,
    setStrategyTypes,
    reset,
  };
}
