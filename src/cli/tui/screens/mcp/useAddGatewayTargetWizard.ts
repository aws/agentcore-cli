import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type { ToolDefinition } from '../../../../schema';
import type { AddGatewayTargetConfig, AddGatewayTargetStep, ComputeHost, ExposureMode, TargetLanguage } from './types';
import { useCallback, useMemo, useState } from 'react';

/**
 * Dynamic steps based on exposure mode.
 * - MCP Runtime: name → language → exposure → agents → confirm
 * - Behind gateway: name → language → exposure → gateway → host → confirm
 */
function getSteps(exposure: ExposureMode): AddGatewayTargetStep[] {
  if (exposure === 'mcp-runtime') {
    return ['name', 'language', 'exposure', 'agents', 'confirm'];
  }
  return ['name', 'language', 'exposure', 'gateway', 'host', 'confirm'];
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
    exposure: 'mcp-runtime',
    host: 'AgentCoreRuntime',
    toolDefinition: deriveToolDefinition(''),
    selectedAgents: [],
  };
}

export function useAddGatewayTargetWizard(existingGateways: string[] = [], existingAgents: string[] = []) {
  const [config, setConfig] = useState<AddGatewayTargetConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayTargetStep>('name');

  const steps = useMemo(() => getSteps(config.exposure), [config.exposure]);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    // Recalculate steps in case exposure changed
    const currentSteps = getSteps(config.exposure);
    const idx = currentSteps.indexOf(step);
    const prevStep = currentSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [config.exposure, step]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({
      ...c,
      name,
      description: `Tool for ${name}`,
      sourcePath: `${APP_DIR}/${MCP_APP_SUBDIR}/${name}`,
      toolDefinition: deriveToolDefinition(name),
    }));
    setStep('language');
  }, []);

  const setLanguage = useCallback((language: TargetLanguage) => {
    setConfig(c => ({
      ...c,
      language,
    }));
    setStep('exposure');
  }, []);

  const setExposure = useCallback((exposure: ExposureMode) => {
    if (exposure === 'mcp-runtime') {
      // MCP Runtime: host is always AgentCoreRuntime, go to agents selection
      setConfig(c => ({
        ...c,
        exposure,
        host: 'AgentCoreRuntime',
        gateway: undefined,
      }));
      setStep('agents');
    } else {
      // Behind gateway: need to select gateway next
      setConfig(c => ({
        ...c,
        exposure,
        selectedAgents: [], // Clear selected agents when switching to gateway mode
      }));
      // If no gateways exist, we should handle this in the UI
      setStep('gateway');
    }
  }, []);

  const setAgents = useCallback((agents: string[]) => {
    setConfig(c => ({
      ...c,
      selectedAgents: agents,
    }));
    setStep('confirm');
  }, []);

  const setGateway = useCallback((gateway: string) => {
    setConfig(c => ({
      ...c,
      gateway,
    }));
    setStep('host');
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
    existingAgents,
    goBack,
    setName,
    setLanguage,
    setExposure,
    setAgents,
    setGateway,
    setHost,
    reset,
  };
}
