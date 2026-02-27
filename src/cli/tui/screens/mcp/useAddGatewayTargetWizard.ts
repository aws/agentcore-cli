import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type { ToolDefinition } from '../../../../schema';
import type { AddGatewayTargetConfig, AddGatewayTargetStep } from './types';
import { useCallback, useMemo, useState } from 'react';

/**
 * Steps for adding a gateway target (existing endpoint only).
 * name → endpoint → gateway → outbound-auth → confirm
 */
function getSteps(): AddGatewayTargetStep[] {
  return ['name', 'endpoint', 'gateway', 'outbound-auth', 'confirm'];
}

function deriveToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool for ${name}`,
    inputSchema: { type: 'object' },
  };
}

function getDefaultConfig(): AddGatewayTargetConfig {
  return {
    name: '',
    description: '',
    sourcePath: '',
    source: 'existing-endpoint',
    language: 'Python',
    host: 'Lambda',
    toolDefinition: deriveToolDefinition(''),
  };
}

export function useAddGatewayTargetWizard(existingGateways: string[] = []) {
  const [config, setConfig] = useState<AddGatewayTargetConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayTargetStep>('name');

  const steps = useMemo(() => getSteps(), []);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const currentSteps = getSteps();
    const idx = currentSteps.indexOf(step);
    const prevStep = currentSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [step]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({
      ...c,
      name,
      description: `Tool for ${name}`,
      sourcePath: `${APP_DIR}/${MCP_APP_SUBDIR}/${name}`,
      toolDefinition: deriveToolDefinition(name),
    }));
    setStep('endpoint');
  }, []);

  const setEndpoint = useCallback((endpoint: string) => {
    setConfig(c => ({
      ...c,
      endpoint,
    }));
    setStep('gateway');
  }, []);

  const setGateway = useCallback((gateway: string) => {
    setConfig(c => ({ ...c, gateway }));
    setStep('outbound-auth');
  }, []);

  const setOutboundAuth = useCallback(
    (outboundAuth: { type: 'OAUTH' | 'API_KEY' | 'NONE'; credentialName?: string }) => {
      setConfig(c => ({
        ...c,
        outboundAuth,
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
    existingGateways,
    goBack,
    setName,
    setEndpoint,
    setGateway,
    setOutboundAuth,
    reset,
  };
}
