import type { ApiGatewayHttpMethod, GatewayTargetType, PassthroughProtocolType } from '../../../../schema';
import { REAL_KB_ID_PATTERN, ToolNameSchema } from '../../../../schema';
import { isGatedFeaturesEnabled } from '../../../feature-flags';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useRuntimeEndpoints } from '../../hooks/useCreateMcp';
import { generateUniqueName } from '../../utils';
import type {
  AddGatewayTargetConfig,
  AddGatewayTargetStep,
  ApiGatewayTargetConfig,
  GatewayTargetWizardState,
  McpServerTargetConfig,
  PassthroughTargetConfig,
  SchemaBasedTargetConfig,
} from './types';
import {
  API_GATEWAY_AUTH_OPTIONS,
  ENTER_KB_ID_MANUALLY,
  MCP_TOOL_STEP_LABELS,
  PASSTHROUGH_PROTOCOL_OPTIONS,
  TARGET_TYPE_OPTIONS,
  getOutboundAuthOptions,
} from './types';
import { useAddGatewayTargetWizard } from './useAddGatewayTargetWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build the credential picker list for a given set of existing credential names. */
function buildCredentialItems(names: string[], credentialLabel: string): SelectableItem[] {
  return [
    ...names.map(name => ({
      id: name,
      title: name,
      description: `Use existing ${credentialLabel}`,
    })),
    { id: 'create-new', title: 'Create new credential', description: `Create a new ${credentialLabel}` },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface AddGatewayTargetScreenProps {
  existingGateways: string[];
  /** Names of gateways with protocolType MCP — not selectable for httpRuntime targets. */
  mcpGatewayNames?: string[];
  /** Runtime names from the project for httpRuntime target selection. */
  existingRuntimeNames?: string[];
  existingToolNames: string[];
  existingOAuthCredentialNames: string[];
  existingApiKeyCredentialNames: string[];
  existingKnowledgeBases: string[];
  onComplete: (config: AddGatewayTargetConfig) => void;
  onCreateCredential: (pendingConfig: GatewayTargetWizardState) => void;
  onExit: () => void;
  initialConfig?: GatewayTargetWizardState;
  initialStep?: AddGatewayTargetStep;
}

export function AddGatewayTargetScreen({
  existingGateways,
  mcpGatewayNames = [],
  existingRuntimeNames = [],
  existingToolNames,
  existingOAuthCredentialNames,
  existingApiKeyCredentialNames,
  existingKnowledgeBases,
  onComplete,
  onCreateCredential,
  onExit,
  initialConfig,
  initialStep,
}: AddGatewayTargetScreenProps) {
  const wizard = useAddGatewayTargetWizard(existingGateways, initialConfig, initialStep);

  // Load endpoints for the selected runtime (used by runtime-endpoint step)
  const { endpoints: runtimeEndpoints, loaded: runtimeEndpointsLoaded } = useRuntimeEndpoints(wizard.config.runtime);

  // Tracks which credential type sub-step is active within either auth step.
  // null = showing the auth type picker; 'OAUTH'/'API_KEY' = showing credential list.
  const [pendingCredType, setPendingCredType] = useState<'OAUTH' | 'API_KEY' | null>(null);
  const [filterPath, setFilterPathLocal] = useState<string | null>(null);
  const [customSigningService, setCustomSigningService] = useState(false);

  // ── Step flags ──
  const isGatewayStep = wizard.step === 'gateway';
  const isOutboundAuthStep = wizard.step === 'outbound-auth';
  const isApiGatewayAuthStep = wizard.step === 'api-gateway-auth';
  const isTargetTypeStep = wizard.step === 'target-type';
  const isTextStep = wizard.step === 'name' || wizard.step === 'endpoint';
  const isRestApiIdStep = wizard.step === 'rest-api-id';
  const isStageStep = wizard.step === 'stage';
  const isToolFiltersStep = wizard.step === 'tool-filters';
  const isSchemaSourceStep = wizard.step === 'schema-source';
  const isLambdaArnStep = wizard.step === 'lambda-arn';
  const isToolSchemaStep = wizard.step === 'tool-schema';
  const isRuntimeStep = wizard.step === 'runtime';
  const isRuntimeEndpointStep = wizard.step === 'runtime-endpoint';
  const isKbSelectStep = wizard.step === 'kb-select';
  const isKbIdStep = wizard.step === 'kb-id';
  const isPassthroughEndpointStep = wizard.step === 'passthrough-endpoint';
  const isPassthroughProtocolStep = wizard.step === 'passthrough-protocol';
  const isPassthroughStickinessStep = wizard.step === 'passthrough-stickiness';
  const isExcludeDomainsStep = wizard.step === 'exclude-domains';
  const isConfirmStep = wizard.step === 'confirm';
  const isAuthStep = isOutboundAuthStep || isApiGatewayAuthStep;
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;

  // Auto-select the gateway for webSearch targets when there's exactly one option.
  useEffect(() => {
    if (
      isGatewayStep &&
      wizard.config.targetType === 'webSearch' &&
      existingGateways.length === 1 &&
      !wizard.config.gateway
    ) {
      wizard.setGateway(existingGateways[0]!);
    }
  }, [isGatewayStep, wizard.config.targetType, existingGateways, wizard.config.gateway, wizard.setGateway]);

  // ── Selectable item lists ──
  const isNonMcpTarget = wizard.config.targetType === 'httpRuntime' || wizard.config.targetType === 'passthrough';
  const isHttpRuntimeTarget = isNonMcpTarget;
  const runtimeItems: SelectableItem[] = useMemo(
    () => existingRuntimeNames.map(r => ({ id: r, title: r })),
    [existingRuntimeNames]
  );
  const runtimeEndpointItems: SelectableItem[] = useMemo(
    () => [
      { id: 'DEFAULT', title: 'DEFAULT (latest version)' },
      ...runtimeEndpoints.map(ep => ({ id: ep.name, title: `${ep.name} (v${ep.version})` })),
    ],
    [runtimeEndpoints]
  );
  const gatewayItems: SelectableItem[] = useMemo(
    () =>
      existingGateways.map(g => {
        const isMcpOnly = isHttpRuntimeTarget && mcpGatewayNames.includes(g);
        return {
          id: g,
          title: isMcpOnly ? `${g} (MCP — not compatible with HTTP Runtime)` : g,
          disabled: isMcpOnly,
        };
      }),
    [existingGateways, mcpGatewayNames, isHttpRuntimeTarget]
  );
  const targetTypeItems: SelectableItem[] = useMemo(
    () =>
      TARGET_TYPE_OPTIONS.map(o => {
        const gated = o.id === 'passthrough' && !isGatedFeaturesEnabled();
        return {
          id: o.id,
          title: o.title,
          description: gated ? 'Coming soon' : o.description,
          disabled: gated,
        };
      }),
    []
  );
  const outboundAuthItems: SelectableItem[] = useMemo(
    () =>
      getOutboundAuthOptions(wizard.config.targetType ?? 'mcpServer').map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    [wizard.config.targetType]
  );
  const passthroughProtocolItems: SelectableItem[] = useMemo(
    () => PASSTHROUGH_PROTOCOL_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const apiGatewayAuthItems: SelectableItem[] = useMemo(
    () => API_GATEWAY_AUTH_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const oauthCredItems: SelectableItem[] = useMemo(
    () => buildCredentialItems(existingOAuthCredentialNames, 'OAuth credential'),
    [existingOAuthCredentialNames]
  );
  const apiKeyCredItems: SelectableItem[] = useMemo(
    () => buildCredentialItems(existingApiKeyCredentialNames, 'API key credential'),
    [existingApiKeyCredentialNames]
  );
  const knowledgeBaseItems: SelectableItem[] = useMemo(
    () => [
      ...existingKnowledgeBases.map(name => ({
        id: name,
        title: name,
        description: 'Project Knowledge Base (resolved at synth)',
      })),
      {
        id: ENTER_KB_ID_MANUALLY,
        title: 'Enter an existing KB ID manually...',
        description: 'Provide a 10-character Bedrock Knowledge Base ID',
      },
    ],
    [existingKnowledgeBases]
  );

  // ── Auth completion callbacks ──
  // Shared handler that routes to the correct wizard setter based on the active step.
  const completeAuth = useCallback(
    (auth?: { type: 'OAUTH' | 'API_KEY' | 'NONE'; credentialName?: string }) => {
      if (isApiGatewayAuthStep) {
        wizard.setApiGatewayAuth(auth as ApiGatewayTargetConfig['outboundAuth']);
      } else {
        wizard.setOutboundAuth(auth ?? { type: 'NONE' });
      }
    },
    [isApiGatewayAuthStep, wizard]
  );

  /** Enter credential selection sub-step, or go straight to creation if none exist. */
  const selectAuthType = useCallback(
    (type: 'OAUTH' | 'API_KEY') => {
      const names = type === 'OAUTH' ? existingOAuthCredentialNames : existingApiKeyCredentialNames;
      if (names.length === 0) {
        onCreateCredential({ ...wizard.config, outboundAuth: { type } });
      } else {
        setPendingCredType(type);
      }
    },
    [existingOAuthCredentialNames, existingApiKeyCredentialNames, onCreateCredential, wizard.config]
  );

  // ── Navigation hooks ──
  const targetTypeNav = useListNavigation({
    items: targetTypeItems,
    onSelect: item => {
      if ((item as SelectableItem & { disabled?: boolean }).disabled) return;
      wizard.setTargetType(item.id as GatewayTargetType);
    },
    onExit: () => wizard.goBack(),
    isActive: isTargetTypeStep,
    isDisabled: item => item.disabled === true,
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  const runtimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => wizard.setRuntime(item.id),
    onExit: () => wizard.goBack(),
    isActive: isRuntimeStep && runtimeItems.length > 0,
  });

  // Auto-skip runtime-endpoint step when the runtime has no endpoints defined.
  // Must wait until endpoints have been loaded to avoid a race condition where the
  // step is skipped before the async fetch completes.
  const hasRuntimeEndpoints = runtimeEndpoints.length > 0;
  React.useEffect(() => {
    if (isRuntimeEndpointStep && runtimeEndpointsLoaded && !hasRuntimeEndpoints) {
      // No endpoints defined — skip to gateway step (select DEFAULT implicitly)
      wizard.setRuntimeEndpoint(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRuntimeEndpointStep, runtimeEndpointsLoaded, hasRuntimeEndpoints]);

  const runtimeEndpointNav = useListNavigation({
    items: runtimeEndpointItems,
    onSelect: item => {
      wizard.setRuntimeEndpoint(item.id === 'DEFAULT' ? undefined : item.id);
    },
    onExit: () => wizard.goBack(),
    isActive: isRuntimeEndpointStep && hasRuntimeEndpoints,
  });

  // Knowledge Base selection (connector branch). Selecting a project KB stores
  // its name on the wizard (resolved at synth from application.knowledgeBases).
  // Selecting "Enter an existing KB ID manually..." advances to the kb-id
  // text-input sub-step for an external KB.
  const knowledgeBaseNav = useListNavigation({
    items: knowledgeBaseItems,
    onSelect: item => {
      if (item.id === ENTER_KB_ID_MANUALLY) {
        wizard.beginManualKbId();
      } else {
        wizard.setKnowledgeBaseId(item.id);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isKbSelectStep,
  });

  // Outbound auth type selection (for mcpServer, openApiSchema, passthrough)
  const outboundAuthNav = useListNavigation({
    items: outboundAuthItems,
    onSelect: item => {
      const authType = item.id as 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH';
      if (authType === 'NONE') {
        completeAuth({ type: 'NONE' });
      } else if (authType === 'GATEWAY_IAM_ROLE' || authType === 'JWT_PASSTHROUGH') {
        wizard.setOutboundAuth({ type: authType });
      } else {
        selectAuthType(authType);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isOutboundAuthStep && !pendingCredType,
  });

  // API Gateway auth type selection (IAM / API_KEY / NONE)
  const apiGatewayAuthNav = useListNavigation({
    items: apiGatewayAuthItems,
    onSelect: item => {
      if (item.id === 'API_KEY') {
        selectAuthType('API_KEY');
      } else if (item.id === 'NONE') {
        completeAuth({ type: 'NONE' });
      } else {
        // IAM — no outboundAuth needed (default)
        completeAuth(undefined);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isApiGatewayAuthStep && !pendingCredType,
  });

  // Shared OAuth credential selection (active in either auth step when pendingCredType is OAUTH)
  const oauthCredNav = useListNavigation({
    items: oauthCredItems,
    onSelect: item => {
      if (item.id === 'create-new') {
        onCreateCredential({ ...wizard.config, outboundAuth: { type: 'OAUTH' } });
      } else {
        completeAuth({ type: 'OAUTH', credentialName: item.id });
      }
    },
    onExit: () => setPendingCredType(null),
    isActive: isAuthStep && pendingCredType === 'OAUTH',
  });

  // Shared API Key credential selection (active in either auth step when pendingCredType is API_KEY)
  const apiKeyCredNav = useListNavigation({
    items: apiKeyCredItems,
    onSelect: item => {
      if (item.id === 'create-new') {
        onCreateCredential({ ...wizard.config, outboundAuth: { type: 'API_KEY' } });
      } else {
        completeAuth({ type: 'API_KEY', credentialName: item.id });
      }
    },
    onExit: () => setPendingCredType(null),
    isActive: isAuthStep && pendingCredType === 'API_KEY',
  });

  // Passthrough protocol selection
  const passthroughProtocolNav = useListNavigation({
    items: passthroughProtocolItems,
    onSelect: item => wizard.setPassthroughProtocol(item.id as PassthroughProtocolType),
    onExit: () => wizard.goBack(),
    isActive: isPassthroughProtocolStep,
  });

  // Signing service selection for passthrough GATEWAY_IAM_ROLE
  const signingServiceNav = useListNavigation({
    items: [
      { id: 'execute-api', title: 'execute-api' },
      { id: 'lambda', title: 'lambda' },
      { id: 'bedrock-agentcore', title: 'bedrock-agentcore' },
      { id: 'custom', title: 'Custom...' },
    ],
    onSelect: item => {
      if (item.id === 'custom') {
        setCustomSigningService(true);
      } else {
        wizard.setSigningService(item.id);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: wizard.step === 'signing-service' && !customSigningService,
  });

  // Confirm step
  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => {
      const c = wizard.config;
      if (c.targetType === 'apiGateway') {
        onComplete({
          targetType: 'apiGateway',
          name: c.name,
          gateway: c.gateway!,
          restApiId: c.restApiId!,
          stage: c.stage!,
          toolFilters: c.toolFilters,
          outboundAuth: c.outboundAuth as ApiGatewayTargetConfig['outboundAuth'],
        });
      } else if (c.targetType === 'openApiSchema' || c.targetType === 'smithyModel') {
        onComplete({
          targetType: c.targetType,
          name: c.name,
          gateway: c.gateway!,
          schemaSource: c.schemaSource!,
          outboundAuth: c.outboundAuth as SchemaBasedTargetConfig['outboundAuth'],
        });
      } else if (c.targetType === 'lambdaFunctionArn') {
        onComplete({
          targetType: 'lambdaFunctionArn',
          name: c.name,
          gateway: c.gateway!,
          lambdaArn: c.lambdaArn!,
          toolSchemaFile: c.toolSchemaFile!,
        });
      } else if (c.targetType === 'httpRuntime') {
        onComplete({
          targetType: 'httpRuntime',
          name: c.name,
          gateway: c.gateway!,
          runtime: c.runtime!,
          endpoint: c.endpoint,
          outboundAuth: c.outboundAuth,
        });
      } else if (c.targetType === 'webSearch') {
        onComplete({
          targetType: 'webSearch',
          name: c.name,
          gateway: c.gateway!,
          ...(c.excludeDomains && c.excludeDomains.length > 0 ? { excludeDomains: c.excludeDomains } : {}),
        });
      } else if (c.targetType === 'connector') {
        // KB connector path. `bedrock-agentic-retrieve` is gateway-managed by
        // the Add Knowledge Base flow, so the TUI only emits
        // `bedrock-knowledge-bases` here.
        onComplete({
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          name: c.name,
          gateway: c.gateway!,
          knowledgeBaseId: c.knowledgeBaseId!,
        });
      } else if (c.targetType === 'passthrough') {
        onComplete({
          targetType: 'passthrough',
          name: c.name,
          gateway: c.gateway!,
          passthroughEndpoint: c.passthroughEndpoint!,
          protocolType: c.passthroughProtocol ?? 'CUSTOM',
          stickinessIdentifier: c.stickinessIdentifier,
          stickinessTimeout: c.stickinessTimeout,
          outboundAuth: c.outboundAuth,
        } as PassthroughTargetConfig);
      } else {
        onComplete({
          targetType: 'mcpServer',
          name: c.name,
          description: c.description ?? `Tool for ${c.name}`,
          endpoint: c.endpoint!,
          gateway: c.gateway!,
          toolDefinition: c.toolDefinition!,
          outboundAuth: c.outboundAuth as McpServerTargetConfig['outboundAuth'],
        });
      }
    },
    onExit: () => {
      setPendingCredType(null);
      wizard.goBack();
    },
    isActive: isConfirmStep,
  });

  // ── Render ──
  const isSigningRegionStep = wizard.step === 'signing-region';
  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isTextStep ||
        isRestApiIdStep ||
        isStageStep ||
        isToolFiltersStep ||
        isSchemaSourceStep ||
        isLambdaArnStep ||
        isToolSchemaStep ||
        isRuntimeStep ||
        isKbIdStep ||
        isPassthroughEndpointStep ||
        isPassthroughStickinessStep ||
        isSigningRegionStep ||
        isExcludeDomainsStep
      ? HELP_TEXT.TEXT_INPUT
      : HELP_TEXT.NAVIGATE_SELECT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MCP_TOOL_STEP_LABELS} />;

  return (
    <Screen title="Add Gateway Target" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isTargetTypeStep && (
          <WizardSelect
            title="Select target type"
            description="What kind of target will this gateway route to?"
            items={targetTypeItems}
            selectedIndex={targetTypeNav.selectedIndex}
          />
        )}

        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Select gateway"
            description="Which gateway will route to this tool?"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {noGatewaysAvailable && <NoGatewaysMessage />}

        {/* Auth type selection — outbound-auth step */}
        {isOutboundAuthStep && !pendingCredType && (
          <WizardSelect
            title="Select outbound authentication"
            description="How will this tool authenticate to external services?"
            items={outboundAuthItems}
            selectedIndex={outboundAuthNav.selectedIndex}
          />
        )}

        {/* Auth type selection — api-gateway-auth step */}
        {isApiGatewayAuthStep && !pendingCredType && (
          <WizardSelect
            title="Select authorization"
            description="How will this target authenticate to the API Gateway?"
            items={apiGatewayAuthItems}
            selectedIndex={apiGatewayAuthNav.selectedIndex}
          />
        )}

        {/* Credential selection — shared between both auth steps */}
        {isAuthStep && pendingCredType === 'OAUTH' && (
          <WizardSelect
            title="Select credential"
            description="Choose an OAuth credential for authentication"
            items={oauthCredItems}
            selectedIndex={oauthCredNav.selectedIndex}
          />
        )}

        {isAuthStep && pendingCredType === 'API_KEY' && (
          <WizardSelect
            title="Select API key credential"
            description="Choose an API key credential for authentication"
            items={apiKeyCredItems}
            selectedIndex={apiKeyCredNav.selectedIndex}
          />
        )}

        {isTextStep && (
          <TextInput
            key={wizard.step}
            prompt={wizard.step === 'endpoint' ? 'MCP server endpoint URL' : MCP_TOOL_STEP_LABELS[wizard.step]}
            initialValue={wizard.step === 'endpoint' ? undefined : generateUniqueName('mytool', existingToolNames)}
            placeholder={wizard.step === 'endpoint' ? 'https://example.com/mcp' : undefined}
            onSubmit={wizard.step === 'endpoint' ? wizard.setEndpoint : wizard.setName}
            onCancel={() => (wizard.currentIndex === 0 ? onExit() : wizard.goBack())}
            schema={wizard.step === 'name' ? ToolNameSchema : undefined}
            customValidation={
              wizard.step === 'name'
                ? value => !existingToolNames.includes(value) || 'Tool name already exists'
                : wizard.step === 'endpoint'
                  ? value => {
                      try {
                        const url = new URL(value);
                        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                          return 'Endpoint must use http:// or https:// protocol';
                        }
                        return true;
                      } catch {
                        return 'Must be a valid URL (e.g. https://example.com/mcp)';
                      }
                    }
                  : undefined
            }
          />
        )}

        {isRestApiIdStep && (
          <TextInput
            prompt="REST API ID"
            placeholder="e.g. abc123def"
            onSubmit={wizard.setRestApiId}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isStageStep && (
          <TextInput
            prompt="Deployment Stage"
            placeholder="e.g. prod"
            onSubmit={wizard.setStage}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isSchemaSourceStep && (
          <TextInput
            prompt={
              wizard.config.targetType === 'smithyModel'
                ? 'Smithy model JSON file (relative to project root) or S3 URI'
                : 'OpenAPI schema JSON file (relative to project root) or S3 URI'
            }
            placeholder="specs/schema.json or s3://bucket/spec.json"
            onSubmit={(value: string) => {
              if (value.startsWith('s3://')) {
                wizard.setSchemaSource({ s3: { uri: value } });
              } else {
                wizard.setSchemaSource({ inline: { path: value } });
              }
            }}
            onCancel={() => wizard.goBack()}
            customValidation={(value: string) => {
              if (!value.trim()) return 'Schema source is required';
              if (value.startsWith('s3://')) {
                if (value.length <= 5) return 'Invalid S3 URI (e.g. s3://bucket/key.json)';
                return true;
              }
              if (!value.endsWith('.json')) return 'Schema file must be a .json file';
              return true;
            }}
          />
        )}

        {/* Tool filters uses a two-phase input within a single wizard step:
            Phase 1: collect filter path pattern
            Phase 2: collect HTTP methods for that path
            Managed via local state (filterPath) rather than separate wizard steps
            because it's a single logical step from the user's perspective. */}
        {isToolFiltersStep && !filterPath && (
          <TextInput
            prompt="Filter path pattern"
            placeholder="e.g. /* or /pets/*"
            onSubmit={(value: string) => setFilterPathLocal(value || '/*')}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isToolFiltersStep && filterPath && (
          <TextInput
            prompt="HTTP methods (comma-separated)"
            placeholder="e.g. GET,POST"
            onSubmit={(value: string) => {
              const methods = value
                .split(',')
                .map(m => m.trim().toUpperCase())
                .filter(Boolean) as ApiGatewayHttpMethod[];
              wizard.setToolFilters([{ filterPath, methods: methods.length > 0 ? methods : ['GET'] }]);
              setFilterPathLocal(null);
            }}
            onCancel={() => setFilterPathLocal(null)}
            customValidation={(value: string) => {
              const methods = value
                .split(',')
                .map(m => m.trim().toUpperCase())
                .filter(Boolean);
              if (methods.length === 0) return true;
              const valid = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
              const invalid = methods.filter(m => !valid.includes(m));
              if (invalid.length > 0) return `Invalid method(s): ${invalid.join(', ')}. Valid: ${valid.join(', ')}`;
              return true;
            }}
          />
        )}

        {isLambdaArnStep && (
          <TextInput
            prompt="Lambda function ARN"
            placeholder="arn:aws:lambda:us-east-1:123456789012:function:my-function"
            onSubmit={wizard.setLambdaArn}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isToolSchemaStep && (
          <TextInput
            prompt="Tool schema file path"
            placeholder="e.g. ./tools.json"
            onSubmit={wizard.setToolSchemaFile}
            onCancel={() => wizard.goBack()}
            customValidation={(value: string) => {
              if (!value) return 'Path is required';
              return true;
            }}
          />
        )}

        {isRuntimeStep && runtimeItems.length > 0 && (
          <WizardSelect
            title="Select runtime"
            description="Which runtime will this target route to?"
            items={runtimeItems}
            selectedIndex={runtimeNav.selectedIndex}
          />
        )}

        {isRuntimeStep && runtimeItems.length === 0 && (
          <TextInput
            prompt="Runtime (name of a runtime from your project)"
            placeholder="e.g. my-agent"
            onSubmit={(value: string) => wizard.setRuntime(value)}
            onCancel={() => wizard.goBack()}
            customValidation={(value: string) => {
              if (!value.trim()) return 'Runtime is required';
              return true;
            }}
          />
        )}

        {isKbSelectStep && (
          <WizardSelect
            title="Select Knowledge Base"
            description="Pick a project Knowledge Base, or enter an existing KB ID manually"
            items={knowledgeBaseItems}
            selectedIndex={knowledgeBaseNav.selectedIndex}
          />
        )}

        {isKbIdStep && (
          <TextInput
            prompt="Knowledge Base ID"
            placeholder="10-character Bedrock KB ID, e.g. ABCDE12345"
            onSubmit={wizard.setKnowledgeBaseId}
            onCancel={() => wizard.goBack()}
            customValidation={(value: string) => {
              if (!value.trim()) return 'KB ID is required';
              if (!REAL_KB_ID_PATTERN.test(value)) {
                return 'Must be a 10-character uppercase alphanumeric Bedrock KB ID (e.g. ABCDE12345)';
              }
              return true;
            }}
          />
        )}

        {isRuntimeEndpointStep && !runtimeEndpointsLoaded && <Text dimColor>Loading runtime endpoints...</Text>}

        {isRuntimeEndpointStep && runtimeEndpointsLoaded && hasRuntimeEndpoints && (
          <WizardSelect
            title="Select runtime endpoint"
            description="Which endpoint version should this target use?"
            items={runtimeEndpointItems}
            selectedIndex={runtimeEndpointNav.selectedIndex}
          />
        )}

        {isPassthroughEndpointStep && (
          <TextInput
            prompt="Passthrough HTTPS endpoint URL"
            placeholder="https://example.com/api"
            onSubmit={wizard.setPassthroughEndpoint}
            onCancel={() => wizard.goBack()}
            customValidation={(value: string) => {
              if (!value.startsWith('https://')) return 'Must start with https://';
              if (!/^https:\/\/[a-zA-Z0-9\-.]+(:[0-9]{1,5})?(\/.*)?$/.test(value)) return 'Must be a valid HTTPS URL';
              return true;
            }}
          />
        )}

        {isPassthroughProtocolStep && (
          <WizardSelect
            title="Select passthrough protocol"
            description="What protocol does the backend speak? CUSTOM is a generic HTTP/REST endpoint."
            items={passthroughProtocolItems}
            selectedIndex={passthroughProtocolNav.selectedIndex}
          />
        )}

        {isPassthroughStickinessStep && (
          <TextInput
            prompt="Stickiness identifier (leave empty to skip)"
            placeholder="$context.header.x-session-id"
            allowEmpty
            onSubmit={(value: string) => {
              if (!value.trim()) {
                wizard.setStickinessConfig(undefined, undefined);
              } else {
                // For simplicity in TUI, use default timeout (skip timeout input)
                wizard.setStickinessConfig(value.trim(), undefined);
              }
            }}
            onCancel={() => wizard.goBack()}
          />
        )}

        {wizard.step === 'signing-service' && (
          <WizardSelect
            title="Select signing service"
            description="Which AWS service should the gateway sign requests for?"
            items={[
              { id: 'execute-api', title: 'execute-api', description: 'API Gateway' },
              { id: 'lambda', title: 'lambda', description: 'AWS Lambda' },
              { id: 'bedrock-agentcore', title: 'bedrock-agentcore', description: 'Bedrock AgentCore' },
              { id: 'custom', title: 'Custom...', description: 'Enter a custom service name' },
            ]}
            selectedIndex={signingServiceNav.selectedIndex}
          />
        )}

        {wizard.step === 'signing-region' && (
          <TextInput
            prompt="Signing region (leave empty for project default)"
            placeholder="us-east-1"
            allowEmpty
            onSubmit={(value: string) => {
              wizard.setSigningRegion(value.trim() || undefined);
            }}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isExcludeDomainsStep && (
          <TextInput
            prompt="Exclude domains (optional, comma-separated)"
            placeholder="e.g. internal.example.com, staging.example.com"
            allowEmpty
            onSubmit={(value: string) => {
              const domains = value
                .split(',')
                .map(d => d.trim())
                .filter(d => d.length > 0);
              wizard.setExcludeDomains(domains.length > 0 ? domains : undefined);
            }}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              {
                label: 'Target Type',
                value:
                  TARGET_TYPE_OPTIONS.find(o => o.id === wizard.config.targetType)?.title ??
                  wizard.config.targetType ??
                  '',
              },
              ...(wizard.config.targetType === 'apiGateway'
                ? [
                    { label: 'REST API ID', value: wizard.config.restApiId ?? '' },
                    { label: 'Stage', value: wizard.config.stage ?? '' },
                    {
                      label: 'Tool Filters',
                      value:
                        wizard.config.toolFilters?.map(f => `${f.filterPath} ${f.methods.join(',')}`).join('; ') ?? '',
                    },
                  ]
                : []),
              ...(wizard.config.targetType === 'lambdaFunctionArn'
                ? [
                    { label: 'Lambda ARN', value: wizard.config.lambdaArn ?? '' },
                    { label: 'Tool Schema File', value: wizard.config.toolSchemaFile ?? '' },
                  ]
                : []),
              ...(wizard.config.targetType === 'httpRuntime'
                ? [
                    { label: 'Runtime', value: wizard.config.runtime ?? '' },
                    ...(wizard.config.endpoint ? [{ label: 'Runtime Endpoint', value: wizard.config.endpoint }] : []),
                  ]
                : []),
              ...(wizard.config.targetType === 'webSearch'
                ? [{ label: 'Exclude domains', value: wizard.config.excludeDomains?.join(', ') ?? '(none)' }]
                : []),
              ...(wizard.config.targetType === 'connector'
                ? [
                    { label: 'Connector', value: wizard.config.connectorId ?? 'bedrock-knowledge-bases' },
                    { label: 'Knowledge Base', value: wizard.config.knowledgeBaseId ?? '' },
                  ]
                : []),
              ...(wizard.config.targetType === 'passthrough'
                ? [
                    { label: 'Endpoint', value: wizard.config.passthroughEndpoint ?? '' },
                    { label: 'Protocol', value: wizard.config.passthroughProtocol ?? 'CUSTOM' },
                    ...(wizard.config.stickinessIdentifier
                      ? [
                          { label: 'Stickiness ID', value: wizard.config.stickinessIdentifier },
                          ...(wizard.config.stickinessTimeout
                            ? [{ label: 'Stickiness Timeout', value: String(wizard.config.stickinessTimeout) }]
                            : []),
                        ]
                      : []),
                  ]
                : []),
              ...(wizard.config.targetType === 'mcpServer' && wizard.config.endpoint
                ? [{ label: 'Endpoint', value: wizard.config.endpoint }]
                : []),
              ...(wizard.config.schemaSource
                ? [
                    {
                      label: 'Schema Source',
                      value:
                        'inline' in wizard.config.schemaSource
                          ? wizard.config.schemaSource.inline.path
                          : wizard.config.schemaSource.s3.uri,
                    },
                  ]
                : []),
              { label: 'Gateway', value: wizard.config.gateway ?? '' },
              ...(wizard.config.targetType !== 'lambdaFunctionArn' && wizard.config.outboundAuth
                ? [
                    { label: 'Auth Type', value: wizard.config.outboundAuth.type },
                    ...(wizard.config.outboundAuth.type === 'GATEWAY_IAM_ROLE'
                      ? [
                          { label: 'Signing Service', value: wizard.config.outboundAuth.service ?? '' },
                          ...(wizard.config.outboundAuth.region
                            ? [{ label: 'Signing Region', value: wizard.config.outboundAuth.region }]
                            : []),
                        ]
                      : wizard.config.outboundAuth.type !== 'JWT_PASSTHROUGH'
                        ? [{ label: 'Credential', value: wizard.config.outboundAuth.credentialName ?? 'None' }]
                        : []),
                  ]
                : wizard.config.targetType === 'apiGateway'
                  ? [{ label: 'Auth Type', value: 'IAM (default)' }]
                  : wizard.config.targetType === 'smithyModel'
                    ? [{ label: 'Auth Type', value: 'IAM Role (automatic)' }]
                    : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

function NoGatewaysMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No gateways found</Text>
      <Text dimColor>Add a gateway first, then attach tools to it.</Text>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}
