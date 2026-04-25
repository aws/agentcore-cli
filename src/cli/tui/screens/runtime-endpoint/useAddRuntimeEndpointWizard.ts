import type { RuntimeEndpointWizardConfig, RuntimeEndpointWizardStep } from './types';
import { useCallback, useMemo, useState } from 'react';

const ALL_STEPS: RuntimeEndpointWizardStep[] = ['runtime', 'endpoint', 'confirm'];

function getDefaultConfig(): RuntimeEndpointWizardConfig {
  return {
    runtimeName: '',
    endpointName: '',
    version: 1,
  };
}

export function useAddRuntimeEndpointWizard(options?: { skipRuntimeStep?: boolean }) {
  const [config, setConfig] = useState<RuntimeEndpointWizardConfig>(getDefaultConfig);
  const [step, setStep] = useState<RuntimeEndpointWizardStep>(options?.skipRuntimeStep ? 'endpoint' : 'runtime');

  const steps = useMemo(
    () => (options?.skipRuntimeStep ? ALL_STEPS.filter(s => s !== 'runtime') : ALL_STEPS),
    [options?.skipRuntimeStep]
  );

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const idx = steps.indexOf(step);
    const prevStep = steps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [steps, step]);

  const setRuntime = useCallback((runtimeName: string) => {
    setConfig(c => ({ ...c, runtimeName }));
    setStep('endpoint');
  }, []);

  const setEndpointDetails = useCallback((endpointName: string, version: number, description?: string) => {
    setConfig(c => ({
      ...c,
      endpointName,
      version,
      ...(description ? { description } : {}),
    }));
    setStep('confirm');
  }, []);

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep(options?.skipRuntimeStep ? 'endpoint' : 'runtime');
  }, [options?.skipRuntimeStep]);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setRuntime,
    setEndpointDetails,
    reset,
  };
}
