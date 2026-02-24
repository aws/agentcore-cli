import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type { ToolDefinition } from '../../../../schema';
import type { AddGatewayTargetConfig, AddGatewayTargetStep, ComputeHost, TargetLanguage } from './types';
import { SKIP_FOR_NOW } from './types';
import { useCallback, useMemo, useState } from 'react';

/**
 * Dynamic steps based on source.
 * - Existing endpoint: name → source → endpoint → gateway → confirm
 * - Create new: name → source → language → gateway → host → confirm
 */
function getSteps(source?: 'existing-endpoint' | 'create-new'): AddGatewayTargetStep[] {
  if (source === 'existing-endpoint') {
    return ['name', 'source', 'endpoint', 'gateway', 'confirm'];
  }
  return ['name', 'source', 'language', 'gateway', 'host', 'confirm'];
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
    language: 'Python',
    host: 'Lambda',
    toolDefinition: deriveToolDefinition(''),
  };
}

export function useAddGatewayTargetWizard(existingGateways: string[] = []) {
  const [config, setConfig] = useState<AddGatewayTargetConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayTargetStep>('name');

  const steps = useMemo(() => getSteps(config.source), [config.source]);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    // Recalculate steps in case source changed
    const currentSteps = getSteps(config.source);
    const idx = currentSteps.indexOf(step);
    const prevStep = currentSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [config.source, step]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({
      ...c,
      name,
      description: `Tool for ${name}`,
      sourcePath: `${APP_DIR}/${MCP_APP_SUBDIR}/${name}`,
      toolDefinition: deriveToolDefinition(name),
    }));
    setStep('source');
  }, []);

  const setSource = useCallback((source: 'existing-endpoint' | 'create-new') => {
    setConfig(c => ({
      ...c,
      source,
    }));
    if (source === 'existing-endpoint') {
      setStep('endpoint');
    } else {
      setStep('language');
    }
  }, []);

  const setEndpoint = useCallback((endpoint: string) => {
    setConfig(c => ({
      ...c,
      endpoint,
    }));
    setStep('gateway');
  }, []);

  const setLanguage = useCallback((language: TargetLanguage) => {
    setConfig(c => ({
      ...c,
      language,
    }));
    setStep('gateway');
  }, []);

  const setGateway = useCallback((gateway: string) => {
    setConfig(c => {
      const isExternal = c.source === 'existing-endpoint';
      const isSkipped = gateway === SKIP_FOR_NOW;
      if (isExternal || isSkipped) {
        setStep('confirm');
      } else {
        setStep('host');
      }
      return { ...c, gateway: isSkipped ? undefined : gateway };
    });
  }, []);

  const setHost = useCallback((host: ComputeHost) => {
    setConfig(c => ({
      ...c,
      host,
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
    existingGateways,
    goBack,
    setName,
    setSource,
    setEndpoint,
    setLanguage,
    setGateway,
    setHost,
    reset,
  };
}
