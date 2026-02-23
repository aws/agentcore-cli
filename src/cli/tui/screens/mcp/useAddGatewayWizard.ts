import type { GatewayAuthorizerType } from '../../../../schema';
import type { AddGatewayConfig, AddGatewayStep } from './types';
import { useCallback, useMemo, useState } from 'react';

/** Maps authorizer type to the next step after authorizer selection */
const AUTHORIZER_NEXT_STEP: Record<GatewayAuthorizerType, AddGatewayStep> = {
  NONE: 'agents',
  AWS_IAM: 'agents',
  CUSTOM_JWT: 'jwt-config',
};

function getDefaultConfig(): AddGatewayConfig {
  return {
    name: '',
    description: '',
    agents: [],
    authorizerType: 'NONE',
    jwtConfig: undefined,
  };
}

export function useAddGatewayWizard() {
  const [config, setConfig] = useState<AddGatewayConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayStep>('name');

  // Dynamic steps based on authorizer type
  const steps = useMemo<AddGatewayStep[]>(() => {
    if (config.authorizerType === 'CUSTOM_JWT') {
      return ['name', 'authorizer', 'jwt-config', 'agents', 'confirm'];
    }
    return ['name', 'authorizer', 'agents', 'confirm'];
  }, [config.authorizerType]);

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({
      ...c,
      name,
      description: `Gateway for ${name}`,
    }));
    setStep('authorizer');
  }, []);

  const setAuthorizerType = useCallback((authorizerType: GatewayAuthorizerType) => {
    setConfig(c => ({
      ...c,
      authorizerType,
      // Clear JWT config if switching away from CUSTOM_JWT
      jwtConfig: authorizerType === 'CUSTOM_JWT' ? c.jwtConfig : undefined,
    }));
    // Navigate to next step based on authorizer type
    setStep(AUTHORIZER_NEXT_STEP[authorizerType]);
  }, []);

  const setJwtConfig = useCallback(
    (jwtConfig: { discoveryUrl: string; allowedAudience: string[]; allowedClients: string[] }) => {
      setConfig(c => ({
        ...c,
        jwtConfig,
      }));
      setStep('agents');
    },
    []
  );

  const setAgents = useCallback((agents: string[]) => {
    setConfig(c => ({
      ...c,
      agents,
    }));
    setStep('confirm');
  }, []);

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setName,
    setAuthorizerType,
    setJwtConfig,
    setAgents,
    reset,
  };
}
