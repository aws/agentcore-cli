import type { GatewayAuthorizerType, GatewayExceptionLevel, PolicyEngineMode } from '../../../../schema';
import type { AddGatewayConfig, AddGatewayStep } from './types';
import { useCallback, useMemo, useState } from 'react';

function getDefaultConfig(): AddGatewayConfig {
  return {
    name: '',
    description: '',
    authorizerType: 'NONE',
    jwtConfig: undefined,
    selectedTargets: [],
    enableSemanticSearch: true,
    exceptionLevel: 'NONE',
  };
}

export function useAddGatewayWizard(unassignedTargetsCount = 0, policyEngineCount = 0) {
  const [config, setConfig] = useState<AddGatewayConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayStep>('name');

  const nextAfterTargets = policyEngineCount > 0 ? 'policy-engine' : 'advanced-config';

  // Dynamic steps based on authorizer type, unassigned targets, and policy engines
  const steps = useMemo<AddGatewayStep[]>(() => {
    const baseSteps: AddGatewayStep[] = ['name', 'authorizer'];

    if (config.authorizerType === 'CUSTOM_JWT') {
      baseSteps.push('jwt-config');
    }

    if (unassignedTargetsCount > 0) {
      baseSteps.push('include-targets');
    }

    if (policyEngineCount > 0) {
      baseSteps.push('policy-engine');
    }

    baseSteps.push('advanced-config');
    baseSteps.push('confirm');

    return baseSteps;
  }, [config.authorizerType, unassignedTargetsCount, policyEngineCount]);

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

  const setAuthorizerType = useCallback(
    (authorizerType: GatewayAuthorizerType) => {
      setConfig(c => ({
        ...c,
        authorizerType,
        // Clear JWT config if switching away from CUSTOM_JWT
        jwtConfig: authorizerType === 'CUSTOM_JWT' ? c.jwtConfig : undefined,
      }));
      // Navigate to next step based on authorizer type
      if (authorizerType === 'CUSTOM_JWT') {
        setStep('jwt-config');
      } else if (unassignedTargetsCount > 0) {
        setStep('include-targets');
      } else {
        setStep(nextAfterTargets);
      }
    },
    [unassignedTargetsCount, nextAfterTargets]
  );

  const setJwtConfig = useCallback(
    (jwtConfig: {
      discoveryUrl: string;
      allowedAudience: string[];
      allowedClients: string[];
      allowedScopes?: string[];
      agentClientId?: string;
      agentClientSecret?: string;
    }) => {
      setConfig(c => ({
        ...c,
        jwtConfig,
      }));
      setStep(unassignedTargetsCount > 0 ? 'include-targets' : nextAfterTargets);
    },
    [unassignedTargetsCount, nextAfterTargets]
  );

  const setSelectedTargets = useCallback(
    (selectedTargets: string[]) => {
      setConfig(c => ({
        ...c,
        selectedTargets,
      }));
      setStep(nextAfterTargets);
    },
    [nextAfterTargets]
  );

  const setPolicyEngineConfig = useCallback((policyEngineName: string, mode: PolicyEngineMode) => {
    setConfig(c => ({
      ...c,
      policyEngineConfiguration: { policyEngineName, mode },
    }));
    setStep('advanced-config');
  }, []);

  const skipPolicyEngine = useCallback(() => {
    setConfig(c => ({ ...c, policyEngineConfiguration: undefined }));
    setStep('advanced-config');
  }, []);

  const setAdvancedConfig = useCallback(
    (opts: { enableSemanticSearch: boolean; exceptionLevel: GatewayExceptionLevel }) => {
      setConfig(c => ({
        ...c,
        enableSemanticSearch: opts.enableSemanticSearch,
        exceptionLevel: opts.exceptionLevel,
      }));
      setStep('confirm');
    },
    []
  );

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
    setSelectedTargets,
    setPolicyEngineConfig,
    skipPolicyEngine,
    setAdvancedConfig,
    reset,
  };
}
