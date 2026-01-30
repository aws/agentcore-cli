import {
  GatewayNameSchema,
  ModelProviderSchema,
  ProviderNameSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
  getSupportedModelProviders,
} from '../../../schema';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddIdentityOptions,
  AddMcpToolOptions,
  AddMemoryOptions,
} from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Constants
const MEMORY_OPTIONS = ['none', 'shortTerm', 'longAndShortTerm'] as const;
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';
const VALID_STRATEGIES = ['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'CUSTOM'];

// Agent validation
export function validateAddAgentOptions(options: AddAgentOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const nameResult = ProviderNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid agent name' };
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

    if (!options.allowedAudience) {
      return { valid: false, error: '--allowed-audience is required for CUSTOM_JWT authorizer' };
    }

    const audiences = options.allowedAudience
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (audiences.length === 0) {
      return { valid: false, error: 'At least one audience value is required' };
    }

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

  return { valid: true };
}

// MCP Tool validation
export function validateAddMcpToolOptions(options: AddMcpToolOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (!options.language) {
    return { valid: false, error: '--language is required' };
  }

  if (options.language !== 'Python' && options.language !== 'TypeScript' && options.language !== 'Other') {
    return { valid: false, error: 'Invalid language. Valid options: Python, TypeScript, Other' };
  }

  if (!options.exposure) {
    return { valid: false, error: '--exposure is required' };
  }

  if (options.exposure !== 'mcp-runtime' && options.exposure !== 'behind-gateway') {
    return { valid: false, error: 'Invalid exposure. Use mcp-runtime or behind-gateway' };
  }

  if (options.exposure === 'mcp-runtime') {
    if (!options.agents) {
      return { valid: false, error: '--agents is required for mcp-runtime exposure' };
    }
    const agents = options.agents
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (agents.length === 0) {
      return { valid: false, error: 'At least one agent is required' };
    }
  } else {
    if (!options.gateway) {
      return { valid: false, error: '--gateway is required for behind-gateway exposure' };
    }
    if (!options.host) {
      return { valid: false, error: '--host is required for behind-gateway exposure' };
    }
    if (options.host !== 'Lambda' && options.host !== 'AgentCoreRuntime') {
      return { valid: false, error: 'Invalid host. Use Lambda or AgentCoreRuntime' };
    }
  }

  return { valid: true };
}

// Memory validation
export function validateAddMemoryOptions(options: AddMemoryOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (!options.strategies) {
    return { valid: false, error: '--strategies is required' };
  }

  const strategies = options.strategies
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (strategies.length === 0) {
    return { valid: false, error: 'At least one strategy is required' };
  }

  for (const strategy of strategies) {
    if (!VALID_STRATEGIES.includes(strategy)) {
      return { valid: false, error: `Invalid strategy: ${strategy}. Must be one of: ${VALID_STRATEGIES.join(', ')}` };
    }
  }

  if (!options.owner) {
    return { valid: false, error: '--owner is required' };
  }

  return { valid: true };
}

// Identity validation
export function validateAddIdentityOptions(options: AddIdentityOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (!options.type) {
    return { valid: false, error: '--type is required' };
  }

  if (options.type !== 'ApiKeyCredentialProvider') {
    return { valid: false, error: 'Invalid type. Only ApiKeyCredentialProvider is supported' };
  }

  if (!options.apiKey) {
    return { valid: false, error: '--api-key is required' };
  }

  if (!options.owner) {
    return { valid: false, error: '--owner is required' };
  }

  return { valid: true };
}
