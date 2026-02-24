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
    selectedTargets: [],
  };
}

export function useAddGatewayWizard(unassignedTargetsCount = 0) {
  const [config, setConfig] = useState<AddGatewayConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayStep>('name');

  // Dynamic steps based on authorizer type and unassigned targets
  const steps = useMemo<AddGatewayStep[]>(() => {
    const baseSteps: AddGatewayStep[] = ['name', 'authorizer'];

    if (config.authorizerType === 'CUSTOM_JWT') {
      baseSteps.push('jwt-config');
    }

    baseSteps.push('agents');

    if (unassignedTargetsCount > 0) {
      baseSteps.push('include-targets');
    }

    baseSteps.push('confirm');

    return baseSteps;
  }, [config.authorizerType, unassignedTargetsCount]);

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

  const setAgents = useCallback(
    (agents: string[]) => {
      setConfig(c => ({
        ...c,
        agents,
      }));
      setStep(unassignedTargetsCount > 0 ? 'include-targets' : 'confirm');
    },
    [unassignedTargetsCount]
  );

  const setSelectedTargets = useCallback((selectedTargets: string[]) => {
    setConfig(c => ({
      ...c,
      selectedTargets,
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
    setSelectedTargets,
    reset,
  };
}
