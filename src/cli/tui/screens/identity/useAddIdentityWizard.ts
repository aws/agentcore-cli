import type { CredentialType } from '../../../../schema';
import type { AddIdentityConfig, AddIdentityStep } from './types';
import { useCallback, useMemo, useState } from 'react';

function getSteps(identityType: CredentialType, skipTypeStep: boolean): AddIdentityStep[] {
  const steps: AddIdentityStep[] =
    identityType === 'OAuthCredentialProvider'
      ? ['type', 'name', 'discoveryUrl', 'clientId', 'clientSecret', 'scopes', 'confirm']
      : ['type', 'name', 'apiKey', 'confirm'];

  return skipTypeStep ? steps.filter(s => s !== 'type') : steps;
}

function getDefaultConfig(initialType?: CredentialType): AddIdentityConfig {
  return {
    identityType: initialType ?? 'ApiKeyCredentialProvider',
    name: '',
    apiKey: '',
  };
}

export function useAddIdentityWizard(initialType?: CredentialType) {
  const hasInitialType = initialType !== undefined;
  const [config, setConfig] = useState<AddIdentityConfig>(() => getDefaultConfig(initialType));
  const [step, setStep] = useState<AddIdentityStep>(hasInitialType ? 'name' : 'type');

  const steps = useMemo(() => getSteps(config.identityType, hasInitialType), [config.identityType, hasInitialType]);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const advanceFrom = useCallback(
    (currentStep: AddIdentityStep) => {
      const currentSteps = getSteps(config.identityType, hasInitialType);
      const idx = currentSteps.indexOf(currentStep);
      const next = currentSteps[idx + 1];
      if (next) setStep(next);
    },
    [config.identityType, hasInitialType]
  );

  const setIdentityType = useCallback((identityType: CredentialType) => {
    setConfig(c => ({
      ...c,
      identityType,
      apiKey: '',
      discoveryUrl: undefined,
      clientId: undefined,
      clientSecret: undefined,
      scopes: undefined,
    }));
    setStep('name');
  }, []);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      advanceFrom('name');
    },
    [advanceFrom]
  );

  const setApiKey = useCallback(
    (apiKey: string) => {
      setConfig(c => ({ ...c, apiKey }));
      advanceFrom('apiKey');
    },
    [advanceFrom]
  );

  const setDiscoveryUrl = useCallback(
    (discoveryUrl: string) => {
      setConfig(c => ({ ...c, discoveryUrl }));
      advanceFrom('discoveryUrl');
    },
    [advanceFrom]
  );

  const setClientId = useCallback(
    (clientId: string) => {
      setConfig(c => ({ ...c, clientId }));
      advanceFrom('clientId');
    },
    [advanceFrom]
  );

  const setClientSecret = useCallback(
    (clientSecret: string) => {
      setConfig(c => ({ ...c, clientSecret }));
      advanceFrom('clientSecret');
    },
    [advanceFrom]
  );

  const setScopes = useCallback(
    (scopes: string) => {
      setConfig(c => ({ ...c, scopes: scopes || undefined }));
      advanceFrom('scopes');
    },
    [advanceFrom]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig(initialType));
    setStep(hasInitialType ? 'name' : 'type');
  }, [initialType, hasInitialType]);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setIdentityType,
    setName,
    setApiKey,
    setDiscoveryUrl,
    setClientId,
    setClientSecret,
    setScopes,
    reset,
  };
}
