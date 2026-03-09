import type { ApiGatewayHttpMethod, GatewayTargetType } from '../../../../schema';
import { ToolNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type {
  AddGatewayTargetConfig,
  AddGatewayTargetStep,
  ApiGatewayTargetConfig,
  GatewayTargetWizardState,
  SchemaBasedTargetConfig,
} from './types';
import { API_GATEWAY_AUTH_OPTIONS, MCP_TOOL_STEP_LABELS, TARGET_TYPE_OPTIONS, getOutboundAuthOptions } from './types';
import { useAddGatewayTargetWizard } from './useAddGatewayTargetWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

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
  existingToolNames: string[];
  existingOAuthCredentialNames: string[];
  existingApiKeyCredentialNames: string[];
  onComplete: (config: AddGatewayTargetConfig) => void;
  onCreateCredential: (pendingConfig: GatewayTargetWizardState) => void;
  onExit: () => void;
  initialConfig?: GatewayTargetWizardState;
  initialStep?: AddGatewayTargetStep;
}

export function AddGatewayTargetScreen({
  existingGateways,
  existingToolNames,
  existingOAuthCredentialNames,
  existingApiKeyCredentialNames,
  onComplete,
  onCreateCredential,
  onExit,
  initialConfig,
  initialStep,
}: AddGatewayTargetScreenProps) {
  const wizard = useAddGatewayTargetWizard(existingGateways, initialConfig, initialStep);

  // Tracks which credential type sub-step is active within either auth step.
  // null = showing the auth type picker; 'OAUTH'/'API_KEY' = showing credential list.
  const [pendingCredType, setPendingCredType] = useState<'OAUTH' | 'API_KEY' | null>(null);
  const [filterPath, setFilterPathLocal] = useState<string | null>(null);

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
  const isConfirmStep = wizard.step === 'confirm';
  const isAuthStep = isOutboundAuthStep || isApiGatewayAuthStep;
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;

  // ── Selectable item lists ──
  const gatewayItems: SelectableItem[] = useMemo(
    () => existingGateways.map(g => ({ id: g, title: g })),
    [existingGateways]
  );
  const targetTypeItems: SelectableItem[] = useMemo(
    () => TARGET_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
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
    onSelect: item => wizard.setTargetType(item.id as GatewayTargetType),
    onExit: () => wizard.goBack(),
    isActive: isTargetTypeStep,
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  // Outbound auth type selection (for mcpServer, openApiSchema)
  const outboundAuthNav = useListNavigation({
    items: outboundAuthItems,
    onSelect: item => {
      const authType = item.id as 'OAUTH' | 'API_KEY' | 'NONE';
      if (authType === 'NONE') {
        completeAuth({ type: 'NONE' });
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
      } else {
        onComplete({
          targetType: 'mcpServer',
          name: c.name,
          description: c.description ?? `Tool for ${c.name}`,
          endpoint: c.endpoint!,
          gateway: c.gateway!,
          toolDefinition: c.toolDefinition!,
          outboundAuth: c.outboundAuth,
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
  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isTextStep || isRestApiIdStep || isStageStep || isToolFiltersStep || isSchemaSourceStep
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
              ...(wizard.config.outboundAuth
                ? [
                    { label: 'Auth Type', value: wizard.config.outboundAuth.type },
                    { label: 'Credential', value: wizard.config.outboundAuth.credentialName ?? 'None' },
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
