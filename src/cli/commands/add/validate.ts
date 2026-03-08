import { ConfigIO } from '../../../lib';
import {
  AgentNameSchema,
  BuildTypeSchema,
  GatewayNameSchema,
  ModelProviderSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
  getSupportedModelProviders,
  matchEnumValue,
} from '../../../schema';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddGatewayTargetOptions,
  AddIdentityOptions,
  AddMemoryOptions,
} from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Constants
const MEMORY_OPTIONS = ['none', 'shortTerm', 'longAndShortTerm'] as const;
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';
const VALID_STRATEGIES = ['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE'];

/**
 * Validate that a credential name exists in the project spec.
 */
async function validateCredentialExists(credentialName: string): Promise<ValidationResult> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();

    const credentialExists = project.credentials.some(c => c.name === credentialName);
    if (!credentialExists) {
      const availableCredentials = project.credentials.map(c => c.name);
      if (availableCredentials.length === 0) {
        return {
          valid: false,
          error: `Credential "${credentialName}" not found. No credentials are configured. Add credentials using 'agentcore add identity'.`,
        };
      }
      return {
        valid: false,
        error: `Credential "${credentialName}" not found. Available credentials: ${availableCredentials.join(', ')}`,
      };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Failed to read project configuration' };
  }
}

// Agent validation
export function validateAddAgentOptions(options: AddAgentOptions): ValidationResult {
  // Normalize enum flag values (case-insensitive matching)
  if (options.framework)
    options.framework =
      (matchEnumValue(SDKFrameworkSchema, options.framework) as typeof options.framework) ?? options.framework;
  if (options.modelProvider)
    options.modelProvider =
      (matchEnumValue(ModelProviderSchema, options.modelProvider) as typeof options.modelProvider) ??
      options.modelProvider;
  if (options.language)
    options.language =
      (matchEnumValue(TargetLanguageSchema, options.language) as typeof options.language) ?? options.language;
  if (options.build) options.build = matchEnumValue(BuildTypeSchema, options.build) ?? options.build;

  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const nameResult = AgentNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid agent name' };
  }

  // Validate build type if provided
  if (options.build) {
    const buildResult = BuildTypeSchema.safeParse(options.build);
    if (!buildResult.success) {
      return { valid: false, error: `Invalid build type: ${options.build}. Use CodeZip or Container` };
    }
  }

  if (!options.framework) {
    return { valid: false, error: '--framework is required' };
  }

  const fwResult = SDKFrameworkSchema.safeParse(options.framework);
  if (!fwResult.success) {
    return { valid: false, error: `Invalid framework: ${options.framework}` };
  }

  if (!options.modelProvider) {
    return { valid: false, error: '--model-provider is required' };
  }

  const mpResult = ModelProviderSchema.safeParse(options.modelProvider);
  if (!mpResult.success) {
    return { valid: false, error: `Invalid model provider: ${options.modelProvider}` };
  }

  const supportedProviders = getSupportedModelProviders(options.framework);
  if (!supportedProviders.includes(options.modelProvider)) {
    return { valid: false, error: `${options.framework} does not support ${options.modelProvider}` };
  }

  if (!options.language) {
    return { valid: false, error: '--language is required' };
  }

  const langResult = TargetLanguageSchema.safeParse(options.language);
  if (!langResult.success) {
    return { valid: false, error: `Invalid language: ${options.language}` };
  }

  const isByoPath = options.type === 'byo';

  if (isByoPath) {
    if (!options.codeLocation) {
      return { valid: false, error: '--code-location is required for BYO path' };
    }
  } else {
    if (options.language === 'TypeScript') {
      return { valid: false, error: 'Create path only supports Python (TypeScript templates not yet available)' };
    }
    if (options.language === 'Other') {
      return { valid: false, error: 'Create path only supports Python' };
    }

    if (!options.memory) {
      return { valid: false, error: '--memory is required for create path' };
    }

    if (!MEMORY_OPTIONS.includes(options.memory as (typeof MEMORY_OPTIONS)[number])) {
      return {
        valid: false,
        error: `Invalid memory option: ${options.memory}. Use none, shortTerm, or longAndShortTerm`,
      };
    }
  }

  return { valid: true };
}

// Gateway validation
export function validateAddGatewayOptions(options: AddGatewayOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const nameResult = GatewayNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid gateway name' };
  }

  if (options.authorizerType && !['NONE', 'CUSTOM_JWT'].includes(options.authorizerType)) {
    return { valid: false, error: 'Invalid authorizer type. Use NONE or CUSTOM_JWT' };
  }

  if (options.authorizerType === 'CUSTOM_JWT') {
    if (!options.discoveryUrl) {
      return { valid: false, error: '--discovery-url is required for CUSTOM_JWT authorizer' };
    }

    try {
      new URL(options.discoveryUrl);
    } catch {
      return { valid: false, error: 'Discovery URL must be a valid URL' };
    }

    if (!options.discoveryUrl.endsWith(OIDC_WELL_KNOWN_SUFFIX)) {
      return { valid: false, error: `Discovery URL must end with ${OIDC_WELL_KNOWN_SUFFIX}` };
    }

    // allowedAudience is optional - empty means no audience validation

    if (!options.allowedClients) {
      return { valid: false, error: '--allowed-clients is required for CUSTOM_JWT authorizer' };
    }

    const clients = options.allowedClients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (clients.length === 0) {
      return { valid: false, error: 'At least one client value is required' };
    }
  }

  // Validate agent OAuth credentials
  if (options.agentClientId && !options.agentClientSecret) {
    return { valid: false, error: 'Both --agent-client-id and --agent-client-secret must be provided together' };
  }
  if (options.agentClientSecret && !options.agentClientId) {
    return { valid: false, error: 'Both --agent-client-id and --agent-client-secret must be provided together' };
  }
  if (options.agentClientId && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: 'Agent OAuth credentials are only valid with CUSTOM_JWT authorizer' };
  }

  return { valid: true };
}

// Gateway Target validation
export async function validateAddGatewayTargetOptions(options: AddGatewayTargetOptions): Promise<ValidationResult> {
  // Normalize enum flag values (case-insensitive matching)
  if (options.language)
    options.language =
      (matchEnumValue(TargetLanguageSchema, options.language) as typeof options.language) ?? options.language;

  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (!options.type) {
    return { valid: false, error: '--type is required. Valid options: mcp-server, api-gateway' };
  }

  const typeMap: Record<string, string> = { 'mcp-server': 'mcpServer', 'api-gateway': 'apiGateway' };
  const mappedType = typeMap[options.type];
  if (!mappedType) {
    return { valid: false, error: `Invalid type: ${options.type}. Valid options: mcp-server, api-gateway` };
  }
  options.type = mappedType;

  // Gateway is required — a gateway target must be attached to a gateway
  if (!options.gateway) {
    return {
      valid: false,
      error:
        "--gateway is required. A gateway target must be attached to a gateway. Create a gateway first with 'agentcore add gateway'.",
    };
  }

  // Validate the specified gateway exists
  const gatewayConfigIO = new ConfigIO();
  let existingGateways: string[] = [];
  try {
    if (gatewayConfigIO.configExists('mcp')) {
      const mcpSpec = await gatewayConfigIO.readMcpSpec();
      existingGateways = mcpSpec.agentCoreGateways.map(g => g.name);
    }
  } catch {
    // If we can't read the config, treat as no gateways
  }
  if (existingGateways.length === 0) {
    return {
      valid: false,
      error: "No gateways found. Create a gateway first with 'agentcore add gateway' before adding a gateway target.",
    };
  }
  if (!existingGateways.includes(options.gateway)) {
    return {
      valid: false,
      error: `Gateway "${options.gateway}" not found. Available gateways: ${existingGateways.join(', ')}`,
    };
  }

  // API Gateway targets: validate early and return (skip outbound auth validation)
  if (mappedType === 'apiGateway') {
    if (!options.restApiId) {
      return { valid: false, error: '--rest-api-id is required for api-gateway type' };
    }
    if (!options.stage) {
      return { valid: false, error: '--stage is required for api-gateway type' };
    }
    if (options.endpoint) {
      return { valid: false, error: '--endpoint is not applicable for api-gateway type' };
    }
    if (options.host) {
      return { valid: false, error: '--host is not applicable for api-gateway type' };
    }
    if (options.language && options.language !== 'Other') {
      return { valid: false, error: '--language is not applicable for api-gateway type' };
    }
    if (options.outboundAuthType) {
      const authLower = options.outboundAuthType.toLowerCase();
      if (authLower === 'oauth') {
        return { valid: false, error: 'OAuth is not supported for api-gateway type' };
      }
      if ((authLower === 'api-key' || authLower === 'api_key') && !options.credentialName) {
        return { valid: false, error: '--credential-name is required with --outbound-auth api-key' };
      }
    }
    if (options.oauthClientId || options.oauthClientSecret || options.oauthDiscoveryUrl || options.oauthScopes) {
      return { valid: false, error: 'OAuth options are not applicable for api-gateway type' };
    }
    options.language = 'Other';
    return { valid: true };
  }

  // Validate outbound auth configuration
  if (options.outboundAuthType && options.outboundAuthType !== 'NONE') {
    const hasInlineOAuth = !!(options.oauthClientId ?? options.oauthClientSecret ?? options.oauthDiscoveryUrl);

    // Reject inline OAuth fields with API_KEY auth type
    if (options.outboundAuthType === 'API_KEY' && hasInlineOAuth) {
      return {
        valid: false,
        error: 'Inline OAuth fields cannot be used with API_KEY outbound auth. Use --credential-name instead.',
      };
    }

    if (!options.credentialName && !hasInlineOAuth) {
      return {
        valid: false,
        error:
          options.outboundAuthType === 'API_KEY'
            ? '--credential-name is required when outbound auth type is API_KEY'
            : `--credential-name or inline OAuth fields (--oauth-client-id, --oauth-client-secret, --oauth-discovery-url) required when outbound auth type is ${options.outboundAuthType}`,
      };
    }

    // Validate inline OAuth fields are complete
    if (hasInlineOAuth) {
      if (!options.oauthClientId)
        return { valid: false, error: '--oauth-client-id is required for inline OAuth credential creation' };
      if (!options.oauthClientSecret)
        return { valid: false, error: '--oauth-client-secret is required for inline OAuth credential creation' };
      if (!options.oauthDiscoveryUrl)
        return { valid: false, error: '--oauth-discovery-url is required for inline OAuth credential creation' };
      try {
        new URL(options.oauthDiscoveryUrl);
      } catch {
        return { valid: false, error: '--oauth-discovery-url must be a valid URL' };
      }
    }

    // Validate that referenced credential exists
    if (options.credentialName) {
      const credentialValidation = await validateCredentialExists(options.credentialName);
      if (!credentialValidation.valid) {
        return credentialValidation;
      }
    }
  }

  if (mappedType === 'mcpServer') {
    if (options.host) {
      return { valid: false, error: '--host is not applicable for MCP server targets' };
    }
    if (!options.endpoint) {
      return { valid: false, error: '--endpoint is required for mcp-server type' };
    }

    try {
      const url = new URL(options.endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { valid: false, error: 'Endpoint must use http:// or https:// protocol' };
      }
    } catch {
      return { valid: false, error: 'Endpoint must be a valid URL (e.g. https://example.com/mcp)' };
    }

    // Populate defaults for fields skipped by external endpoint flow
    options.language ??= 'Other';

    return { valid: true };
  }

  if (!options.language) {
    return { valid: false, error: '--language is required' };
  }

  if (options.language !== 'Python' && options.language !== 'TypeScript' && options.language !== 'Other') {
    return { valid: false, error: 'Invalid language. Valid options: Python, TypeScript, Other' };
  }

  return { valid: true };
}

// Memory validation (v2: top-level resource, no owner)
export function validateAddMemoryOptions(options: AddMemoryOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (options.strategies) {
    const strategies = options.strategies
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    for (const strategy of strategies) {
      if (!VALID_STRATEGIES.includes(strategy)) {
        return { valid: false, error: `Invalid strategy: ${strategy}. Must be one of: ${VALID_STRATEGIES.join(', ')}` };
      }
    }
  }

  return { valid: true };
}

// Identity validation (v2: credential resource, no owner)
export function validateAddIdentityOptions(options: AddIdentityOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const identityType = options.type ?? 'api-key';

  if (identityType === 'oauth') {
    if (!options.discoveryUrl) {
      return { valid: false, error: '--discovery-url is required for OAuth credentials' };
    }
    try {
      new URL(options.discoveryUrl);
    } catch {
      return { valid: false, error: '--discovery-url must be a valid URL' };
    }
    if (!options.clientId) {
      return { valid: false, error: '--client-id is required for OAuth credentials' };
    }
    if (!options.clientSecret) {
      return { valid: false, error: '--client-secret is required for OAuth credentials' };
    }
    return { valid: true };
  }

  if (!options.apiKey) {
    return { valid: false, error: '--api-key is required' };
  }

  return { valid: true };
}
