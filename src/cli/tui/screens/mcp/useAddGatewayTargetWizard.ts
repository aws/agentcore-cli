import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type {
  ApiGatewayHttpMethod,
  GatewayTargetType,
  PassthroughProtocolType,
  SchemaSource,
  ToolDefinition,
} from '../../../../schema';
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

export function useAddGatewayTargetWizard(
  existingGateways: string[] = [],
  initialConfig?: GatewayTargetWizardState,
  initialStep?: AddGatewayTargetStep
) {
  const [config, setConfig] = useState<GatewayTargetWizardState>(() => initialConfig ?? getDefaultConfig());
  const [step, setStep] = useState<AddGatewayTargetStep>(initialStep ?? 'name');

  // Dynamic steps — recomputes when targetType changes
  const steps = useMemo<AddGatewayTargetStep[]>(() => {
    const baseSteps: AddGatewayTargetStep[] = ['name', 'target-type'];
    if (config.targetType) {
      switch (config.targetType) {
        case 'apiGateway':
          baseSteps.push('rest-api-id', 'stage', 'tool-filters', 'gateway', 'api-gateway-auth');
          break;
        case 'openApiSchema':
          baseSteps.push('schema-source', 'gateway', 'outbound-auth');
          break;
        case 'smithyModel':
          baseSteps.push('schema-source', 'gateway');
          break;
        case 'lambdaFunctionArn':
          baseSteps.push('lambda-arn', 'tool-schema', 'gateway');
          break;
        case 'httpRuntime':
          baseSteps.push('runtime', 'runtime-endpoint', 'gateway', 'outbound-auth');
          break;
        case 'connector':
          // Connector (Knowledge Base) flow: select a KB (project name or
          // literal 10-char ID), then attach to a gateway. No outbound auth —
          // connector targets are managed by the gateway IAM role.
          baseSteps.push('kb-select', 'gateway');
          break;
        case 'passthrough':
          baseSteps.push(
            'passthrough-endpoint',
            'passthrough-protocol',
            'passthrough-stickiness',
            'gateway',
            'outbound-auth',
            'signing-service',
            'signing-region'
          );
          break;
        case 'webSearch':
          // Amazon Web Search flow: pick a gateway, optionally specify domains
          // to exclude. No outbound auth — managed by the gateway IAM role.
          baseSteps.push('gateway', 'exclude-domains');
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

  // The 'kb-id' step is a sub-step of 'kb-select' for manual literal-KB-ID entry.
  // It is not part of the canonical step list, so map it onto kb-select for
  // navigation/index purposes.
  const stepForIndex: AddGatewayTargetStep = step === 'kb-id' ? 'kb-select' : step;
  const currentIndex = steps.indexOf(stepForIndex);

  const goToNextStep = useCallback(() => {
    const lookup = step === 'kb-id' ? 'kb-select' : step;
    const idx = steps.indexOf(lookup);
    const next = steps[idx + 1];
    if (idx >= 0 && next) {
      setStep(next);
    }
  }, [steps, step]);

  const goBack = useCallback(() => {
    // From the manual KB-ID entry, fall back to the KB selection picker.
    if (step === 'kb-id') {
      setStep('kb-select');
      return;
    }
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps, step]);

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
    // KB connector targets default to 'bedrock-knowledge-bases' for the TUI;
    // 'bedrock-agentic-retrieve' is gateway-managed by the Add Knowledge Base
    // flow and not directly exposed here. webSearch targets carry no connectorId.
    const connectorIdDefault = targetType === 'connector' ? ('bedrock-knowledge-bases' as const) : undefined;
    setConfig(c => ({
      ...c,
      targetType,
      ...(connectorIdDefault ? { connectorId: connectorIdDefault } : { connectorId: undefined }),
      ...(targetType !== 'webSearch' ? { excludeDomains: undefined } : {}),
    }));
    // Cannot use goToNextStep() here — config.targetType is changing, which triggers
    // useMemo to recompute steps, but goToNextStep captures the OLD steps via closure.
    // Must explicitly set the first type-specific step.
    switch (targetType) {
      case 'apiGateway':
        setStep('rest-api-id');
        break;
      case 'openApiSchema':
      case 'smithyModel':
        setStep('schema-source');
        break;
      case 'lambdaFunctionArn':
        setStep('lambda-arn');
        break;
      case 'httpRuntime':
        setStep('runtime');
        break;
      case 'connector':
        setStep('kb-select');
        break;
      case 'passthrough':
        setStep('passthrough-endpoint');
        break;
      case 'webSearch':
        setStep('gateway');
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

  const setSchemaSource = useCallback(
    (schemaSource: SchemaSource) => {
      setConfig(c => ({ ...c, schemaSource }));
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
    (outboundAuth: {
      type: 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH';
      credentialName?: string;
    }) => {
      setConfig(c => ({
        ...c,
        outboundAuth,
      }));
      // For GATEWAY_IAM_ROLE, next step is signing-service (handled via steps array)
      // For JWT_PASSTHROUGH and others, skip signing steps (go to confirm)
      if (outboundAuth.type === 'GATEWAY_IAM_ROLE') {
        setStep('signing-service');
      } else {
        // Skip signing-service and signing-region, go to confirm
        setStep('confirm');
      }
    },
    []
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

  const setApiGatewayAuth = useCallback(
    (outboundAuth?: { type: 'API_KEY' | 'NONE'; credentialName?: string }) => {
      setConfig(c => ({ ...c, outboundAuth }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setLambdaArn = useCallback(
    (lambdaArn: string) => {
      setConfig(c => ({ ...c, lambdaArn }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setToolSchemaFile = useCallback(
    (toolSchemaFile: string) => {
      setConfig(c => ({ ...c, toolSchemaFile }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setRuntime = useCallback(
    (runtime: string) => {
      setConfig(c => ({ ...c, runtime }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setRuntimeEndpoint = useCallback(
    (endpoint: string | undefined) => {
      setConfig(c => ({ ...c, endpoint }));
      goToNextStep();
    },
    [goToNextStep]
  );

  /**
   * Set the Knowledge Base reference (a project KB name or a literal 10-char
   * external KB ID) and advance to the gateway step. The wizard's `name`
   * field defaults to the KB reference if the user hasn't typed one yet.
   */
  const setKnowledgeBaseId = useCallback(
    (knowledgeBaseId: string) => {
      setConfig(c => ({
        ...c,
        knowledgeBaseId,
        name: c.name || knowledgeBaseId,
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setPassthroughEndpoint = useCallback(
    (passthroughEndpoint: string) => {
      setConfig(c => ({ ...c, passthroughEndpoint }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setPassthroughProtocol = useCallback(
    (passthroughProtocol: PassthroughProtocolType) => {
      setConfig(c => ({ ...c, passthroughProtocol }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setStickinessConfig = useCallback(
    (identifier?: string, timeout?: number) => {
      setConfig(c => ({
        ...c,
        stickinessIdentifier: identifier,
        stickinessTimeout: timeout,
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  /** Switch from the kb-select picker to the manual literal-ID entry step. */
  const beginManualKbId = useCallback(() => {
    setStep('kb-id');
  }, []);

  const setSigningService = useCallback(
    (signingService: string) => {
      setConfig(c => ({
        ...c,
        signingService,
        outboundAuth: { ...c.outboundAuth!, service: signingService },
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  const setSigningRegion = useCallback(
    (signingRegion?: string) => {
      setConfig(c => ({
        ...c,
        signingRegion,
        outboundAuth: { ...c.outboundAuth!, region: signingRegion },
      }));
      goToNextStep();
    },
    [goToNextStep]
  );

  /**
   * Set the optional list of domains to exclude (web-search connector only)
   * and advance to confirm. An empty submission clears the field.
   */
  const setExcludeDomains = useCallback(
    (excludeDomains: string[] | undefined) => {
      setConfig(c => ({
        ...c,
        excludeDomains: excludeDomains && excludeDomains.length > 0 ? excludeDomains : undefined,
      }));
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
    setSchemaSource,
    setGateway,
    setOutboundAuth,
    setRestApiId,
    setStage,
    setToolFilters,
    setApiGatewayAuth,
    setLambdaArn,
    setToolSchemaFile,
    setRuntime,
    setRuntimeEndpoint,
    setKnowledgeBaseId,
    beginManualKbId,
    setPassthroughEndpoint,
    setPassthroughProtocol,
    setStickinessConfig,
    setSigningService,
    setSigningRegion,
    setExcludeDomains,
    reset,
  };
}
