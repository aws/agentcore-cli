import type { CredentialType } from '../../../../schema';
import type { AddIdentityConfig, AddIdentityStep } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddIdentityStep[] = ['type', 'name', 'apiKey', 'confirm'];

function getDefaultConfig(): AddIdentityConfig {
  return {
    identityType: 'ApiKeyCredentialProvider',
    name: '',
    apiKey: '',
  };
}

export function useAddIdentityWizard() {
  const [config, setConfig] = useState<AddIdentityConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddIdentityStep>('type');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex]);

  const nextStep = useCallback((currentStep: AddIdentityStep): AddIdentityStep | undefined => {
    const idx = ALL_STEPS.indexOf(currentStep);
    return ALL_STEPS[idx + 1];
  }, []);

  const setIdentityType = useCallback(
    (identityType: CredentialType) => {
      setConfig(c => ({ ...c, identityType }));
      const next = nextStep('type');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setApiKey = useCallback(
    (apiKey: string) => {
      setConfig(c => ({ ...c, apiKey }));
      const next = nextStep('apiKey');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('type');
  }, []);

  return {
    config,
    step,
    steps: ALL_STEPS,
    currentIndex,
    goBack,
    setIdentityType,
    setName,
    setApiKey,
    reset,
  };
}
