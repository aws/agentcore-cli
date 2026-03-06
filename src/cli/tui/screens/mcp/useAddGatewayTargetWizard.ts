import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type { ApiGatewayHttpMethod, GatewayTargetType, ToolDefinition } from '../../../../schema';
import type { AddGatewayTargetStep, GatewayTargetWizardState } from './types';
import { useCallback, useMemo, useState } from 'react';

function deriveToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool for ${name}`,
    inputSchema: { type: 'object' },
  };
}

function getDefaultConfig(): GatewayTargetWizardState {
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
  const [config, setConfig] = useState<GatewayTargetWizardState>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayTargetStep>('name');

  // Dynamic steps — recomputes when targetType changes
  const steps = useMemo<AddGatewayTargetStep[]>(() => {
    const baseSteps: AddGatewayTargetStep[] = ['name', 'target-type'];
    if (config.targetType) {
      switch (config.targetType) {
        case 'apiGateway':
          baseSteps.push('rest-api-id', 'stage', 'tool-filters', 'gateway');
          break;
        case 'mcpServer':
        default:
          baseSteps.push('endpoint', 'gateway', 'outbound-auth');
          break;
      }
      baseSteps.push('confirm');
    }
    return baseSteps;
  }, [config.targetType]);

  const currentIndex = steps.indexOf(step);

  const goToNextStep = useCallback(() => {
    const idx = steps.indexOf(step);
    const next = steps[idx + 1];
    if (idx >= 0 && next) {
      setStep(next);
    }
  }, [steps, step]);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({
        ...c,
        name,
        description: `Tool for ${name}`,
        sourcePath: `${APP_DIR}/${MCP_APP_SUBDIR}/${name}`,
        toolDefinition: deriveToolDefinition(name),
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setTargetType = useCallback((targetType: GatewayTargetType) => {
    setConfig(c => ({ ...c, targetType }));
    // Cannot use goToNextStep() here — config.targetType is changing, which triggers
    // useMemo to recompute steps, but goToNextStep captures the OLD steps via closure.
    // Must explicitly set the first type-specific step.
    switch (targetType) {
      case 'apiGateway':
        setStep('rest-api-id');
        break;
      case 'mcpServer':
      default:
        setStep('endpoint');
        break;
    }
  }, []);

  const setEndpoint = useCallback(
    (endpoint: string) => {
      setConfig(c => ({
        ...c,
        endpoint,
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setGateway = useCallback(
    (gateway: string) => {
      setConfig(c => ({ ...c, gateway }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setOutboundAuth = useCallback(
    (outboundAuth: { type: 'OAUTH' | 'API_KEY' | 'NONE'; credentialName?: string }) => {
      setConfig(c => ({
        ...c,
        outboundAuth,
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  const setRestApiId = useCallback(
    (restApiId: string) => {
      setConfig(c => ({ ...c, restApiId }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setStage = useCallback(
    (stage: string) => {
      setConfig(c => ({ ...c, stage }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setToolFilters = useCallback(
    (toolFilters: { filterPath: string; methods: ApiGatewayHttpMethod[] }[]) => {
      setConfig(c => ({ ...c, toolFilters }));
      goToNextStep();
    },
    [goToNextStep]
  );

  return {
    config,
    step,
    steps,
    currentIndex,
    existingGateways,
    goBack,
    setName,
    setTargetType,
    setEndpoint,
    setGateway,
    setOutboundAuth,
    setRestApiId,
    setStage,
    setToolFilters,
    reset,
  };
}
