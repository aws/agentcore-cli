import { ConfigIO, findConfigRoot } from '../../../lib';
import {
  AgentNameSchema,
  BuildTypeSchema,
  CONNECTOR_ID_VALUES,
  DatasetNameSchema,
  DatasetSchemaTypeSchema,
  GatewayAuthorizerTypeSchema,
  GatewayExceptionLevelSchema,
  GatewayNameSchema,
  ModelProviderSchema,
  ProtocolModeSchema,
  RuntimeAuthorizerTypeSchema,
  SDKFrameworkSchema,
  SessionStorageSchema,
  StreamDeliveryResourcesSchema,
  TARGET_TYPE_AUTH_CONFIG,
  TargetLanguageSchema,
  getFrameworksForLanguage,
  getSupportedFrameworksForProtocol,
  getSupportedModelProviders,
  isFrameworkSupportedForLanguage,
  isValidKmsKeyArn,
  matchEnumValue,
  validateApiFormat,
} from '../../../schema';
import { ARN_VALIDATION_MESSAGE, isValidArn } from '../shared/arn-utils';
import { validateHeaderAllowlist } from '../shared/header-utils';
import { MAX_INDEXED_KEYS, parseIndexedKeyArg } from '../shared/indexed-key-parser';
import { parseAndValidateLifecycleOptions } from '../shared/lifecycle-utils';
import { validateVpcOptions } from '../shared/vpc-utils';
import { validateJwtAuthorizerOptions } from './auth-options';
import type {
  AddAgentOptions,
  AddCredentialOptions,
  AddDatasetOptions,
  AddGatewayOptions,
  AddGatewayTargetOptions,
  AddHarnessCliOptions,
  AddMemoryOptions,
} from './types';
import { existsSync, readFileSync } from 'fs';
import { dirname, extname, isAbsolute, join, resolve } from 'path';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Constants
const MEMORY_OPTIONS = ['none', 'shortTerm', 'longAndShortTerm'] as const;
const VALID_STRATEGIES = ['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC'];
const VALID_STREAM_CONTENT_LEVELS = ['FULL_CONTENT', 'METADATA_ONLY'];
const VALID_DELIVERY_TYPES = ['kinesis'] as const;
export const DEFAULT_DELIVERY_TYPE = 'kinesis';

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
          error: `Credential "${credentialName}" not found. No credentials are configured. Add credentials using 'agentcore add credential'.`,
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
  if (options.protocol)
    options.protocol =
      (matchEnumValue(ProtocolModeSchema, options.protocol) as typeof options.protocol) ?? options.protocol;
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

  // Session storage is not supported for TypeScript agents — reject early before any path-specific returns
  if (options.sessionStorageMountPath && options.language === 'TypeScript') {
    return { valid: false, error: '--session-storage-mount-path is not supported for TypeScript agents' };
  }

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

  // Validate and normalize protocol
  const protocol = options.protocol ?? 'HTTP';
  const protocolResult = ProtocolModeSchema.safeParse(protocol);
  if (!protocolResult.success) {
    return { valid: false, error: `Invalid protocol: ${protocol}. Use HTTP, MCP, A2A, or AGUI` };
  }
  options.protocol = protocolResult.data;

  // TypeScript only supports HTTP today; MCP and A2A templates have not been authored yet
  if (protocolResult.data !== 'HTTP' && options.language === 'TypeScript') {
    return {
      valid: false,
      error: `${protocolResult.data} protocol is not yet supported for TypeScript. Use --protocol HTTP or --language Python.`,
    };
  }

  const isByoPath = options.type === 'byo';
  const isImportPath = options.type === 'import';

  // Import path: validate import-specific options and return early
  if (isImportPath) {
    if (!options.agentId) {
      return { valid: false, error: '--agent-id is required for import path' };
    }
    if (!options.agentAliasId) {
      return { valid: false, error: '--agent-alias-id is required for import path' };
    }
    if (!options.region) {
      return { valid: false, error: '--region is required for import path' };
    }
    if (!options.framework) {
      return { valid: false, error: '--framework is required for import path' };
    }
    if (options.framework !== 'Strands' && options.framework !== 'LangChain_LangGraph') {
      return { valid: false, error: 'Import path only supports Strands or LangChain_LangGraph frameworks' };
    }
    if (!options.memory) {
      return { valid: false, error: '--memory is required for import path' };
    }
    if (!MEMORY_OPTIONS.includes(options.memory as (typeof MEMORY_OPTIONS)[number])) {
      return {
        valid: false,
        error: `Invalid memory option: ${options.memory}. Use none, shortTerm, or longAndShortTerm`,
      };
    }
    // Parse and validate lifecycle configuration for import path
    const lcResult = parseAndValidateLifecycleOptions(options);
    if (!lcResult.valid) return lcResult;
    if (lcResult.idleTimeout !== undefined) options.idleTimeout = lcResult.idleTimeout;
    if (lcResult.maxLifetime !== undefined) options.maxLifetime = lcResult.maxLifetime;

    // Force import defaults
    options.modelProvider = 'Bedrock' as typeof options.modelProvider;
    options.language = 'Python' as typeof options.language;
    return { valid: true };
  }

  // MCP protocol: no framework, model provider, or memory
  if (protocol === 'MCP') {
    if (options.framework) {
      return { valid: false, error: '--framework is not applicable for MCP protocol' };
    }
    if (options.modelProvider) {
      return { valid: false, error: '--model-provider is not applicable for MCP protocol' };
    }
    if (options.memory && options.memory !== 'none') {
      return { valid: false, error: '--memory is not applicable for MCP protocol' };
    }

    if (!options.language) {
      return { valid: false, error: '--language is required' };
    }
    const langResult = TargetLanguageSchema.safeParse(options.language);
    if (!langResult.success) {
      return { valid: false, error: `Invalid language: ${options.language}` };
    }

    if (isByoPath && !options.codeLocation) {
      return { valid: false, error: '--code-location is required for BYO path' };
    }

    // Parse and validate lifecycle configuration for MCP path
    const mcpLcResult = parseAndValidateLifecycleOptions(options);
    if (!mcpLcResult.valid) return mcpLcResult;
    if (mcpLcResult.idleTimeout !== undefined) options.idleTimeout = mcpLcResult.idleTimeout;
    if (mcpLcResult.maxLifetime !== undefined) options.maxLifetime = mcpLcResult.maxLifetime;

    return { valid: true };
  }

  // Framework selects a template for create paths. BYO paths use the supplied code directly.
  if (!isByoPath && !options.framework) {
    return { valid: false, error: '--framework is required' };
  }

  if (options.framework) {
    const fwResult = SDKFrameworkSchema.safeParse(options.framework);
    if (!fwResult.success) {
      return { valid: false, error: `Invalid framework: ${options.framework}` };
    }

    // Validate an explicitly supplied framework against the selected protocol
    if (protocol !== 'HTTP') {
      const supportedFrameworks = getSupportedFrameworksForProtocol(protocol);
      if (!supportedFrameworks.includes(options.framework)) {
        return { valid: false, error: `${options.framework} does not support ${protocol} protocol` };
      }
    }
  }

  // BYO agents default to Bedrock when no model provider is specified. This keeps
  // the downstream credential path aligned with the documented BYO example.
  if (isByoPath && !options.modelProvider) {
    options.modelProvider = 'Bedrock';
  }

  if (!options.modelProvider) {
    return { valid: false, error: '--model-provider is required' };
  }

  const mpResult = ModelProviderSchema.safeParse(options.modelProvider);
  if (!mpResult.success) {
    return { valid: false, error: `Invalid model provider: ${options.modelProvider}` };
  }

  if (!isByoPath && options.framework) {
    const supportedProviders = getSupportedModelProviders(options.framework);
    if (!supportedProviders.includes(options.modelProvider)) {
      return { valid: false, error: `${options.framework} does not support ${options.modelProvider}` };
    }
  }

  if (!options.language) {
    return { valid: false, error: '--language is required' };
  }

  const langResult = TargetLanguageSchema.safeParse(options.language);
  if (!langResult.success) {
    return { valid: false, error: `Invalid language: ${options.language}` };
  }

  if (isByoPath) {
    if (!options.codeLocation) {
      return { valid: false, error: '--code-location is required for BYO path' };
    }
  } else {
    if (options.language === 'Other') {
      return { valid: false, error: 'Create path only supports Python or TypeScript' };
    }
    // Framework must ship a template for the chosen language (e.g. Vercel AI is
    // TypeScript-only, the other open-source frameworks are Python-only).
    if (
      (langResult.data === 'Python' || langResult.data === 'TypeScript') &&
      !isFrameworkSupportedForLanguage(langResult.data, options.framework!)
    ) {
      const supported = getFrameworksForLanguage(langResult.data).join(', ');
      return {
        valid: false,
        error: `Framework ${options.framework} is not yet available for ${langResult.data}. Supported: ${supported}.`,
      };
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

  // Validate request header allowlist
  if (options.requestHeaderAllowlist) {
    const headerResult = validateHeaderAllowlist(options.requestHeaderAllowlist);
    if (!headerResult.success) {
      return { valid: false, error: headerResult.error };
    }
  }

  // Parse and validate lifecycle configuration
  const lifecycleResult = parseAndValidateLifecycleOptions(options);
  if (!lifecycleResult.valid) return lifecycleResult;
  if (lifecycleResult.idleTimeout !== undefined) options.idleTimeout = lifecycleResult.idleTimeout;
  if (lifecycleResult.maxLifetime !== undefined) options.maxLifetime = lifecycleResult.maxLifetime;

  // Validate session storage mount path format (TypeScript rejection is handled at the top)
  if (options.sessionStorageMountPath) {
    const mountPathResult = SessionStorageSchema.shape.mountPath.safeParse(options.sessionStorageMountPath);
    if (!mountPathResult.success) {
      return { valid: false, error: `--session-storage-mount-path: ${mountPathResult.error.issues[0]?.message}` };
    }
  }

  // Validate VPC options
  const vpcResult = validateVpcOptions(options, options.build);
  if (!vpcResult.valid) {
    return { valid: false, error: vpcResult.error };
  }

  // Validate authorizer options (applies to both create and BYO paths)
  if (options.authorizerType) {
    const authResult = RuntimeAuthorizerTypeSchema.safeParse(options.authorizerType);
    if (!authResult.success) {
      return { valid: false, error: 'Invalid authorizer type. Use AWS_IAM or CUSTOM_JWT' };
    }

    if (options.authorizerType === 'CUSTOM_JWT') {
      const jwtResult = validateJwtAuthorizerOptions(options);
      if (!jwtResult.valid) return jwtResult;
    }
  }

  // Validate OAuth client credentials require CUSTOM_JWT
  if (options.clientId && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: 'OAuth client credentials are only valid with CUSTOM_JWT authorizer' };
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

  if (options.authorizerType) {
    const result = GatewayAuthorizerTypeSchema.safeParse(options.authorizerType);
    if (!result.success) {
      const valid = GatewayAuthorizerTypeSchema.options.join(', ');
      return { valid: false, error: `Invalid authorizer type. Use ${valid}` };
    }
  }

  if (options.authorizerType === 'CUSTOM_JWT') {
    const jwtResult = validateJwtAuthorizerOptions(options);
    if (!jwtResult.valid) return jwtResult;
  }

  // Validate OAuth client credentials require CUSTOM_JWT
  if (options.clientId && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: 'OAuth client credentials are only valid with CUSTOM_JWT authorizer' };
  }

  // Validate exception level if provided
  if (options.exceptionLevel) {
    const levelResult = GatewayExceptionLevelSchema.safeParse(options.exceptionLevel);
    if (!levelResult.success) {
      return { valid: false, error: `Invalid exception level: ${options.exceptionLevel}. Use NONE or DEBUG` };
    }
  }

  // Validate policy engine options
  if (options.policyEngine && !options.policyEngineMode) {
    return { valid: false, error: '--policy-engine-mode is required when --policy-engine is specified' };
  }
  if (options.policyEngineMode && !options.policyEngine) {
    return { valid: false, error: '--policy-engine is required when --policy-engine-mode is specified' };
  }
  if (options.policyEngineMode && !['LOG_ONLY', 'ENFORCE'].includes(options.policyEngineMode)) {
    return { valid: false, error: `Invalid policy engine mode: ${options.policyEngineMode}. Use LOG_ONLY or ENFORCE` };
  }

  return { valid: true };
}

// Gateway Target validation
export async function validateAddGatewayTargetOptions(options: AddGatewayTargetOptions): Promise<ValidationResult> {
  // Normalize enum flag values (case-insensitive matching)
  if (options.language)
    options.language =
      (matchEnumValue(TargetLanguageSchema, options.language) as typeof options.language) ?? options.language;

  const kbConnectors = ['bedrock-knowledge-bases'];
  const nameOptional = options.type === 'connector' && kbConnectors.includes(options.connector ?? '');
  if (!options.name && !nameOptional) {
    return { valid: false, error: '--name is required' };
  }

  const validTypeList = [
    'mcp-server',
    'api-gateway',
    'open-api-schema',
    'smithy-model',
    'lambda-function-arn',
    'http-runtime',
    'connector',
    'passthrough',
  ].join(', ');

  if (!options.type) {
    return {
      valid: false,
      error: `--type is required. Valid options: ${validTypeList}`,
    };
  }

  const typeMap: Record<string, string> = {
    'mcp-server': 'mcpServer',
    'api-gateway': 'apiGateway',
    'open-api-schema': 'openApiSchema',
    'smithy-model': 'smithyModel',
    'lambda-function-arn': 'lambdaFunctionArn',
    'http-runtime': 'httpRuntime',
    connector: 'connector',
    passthrough: 'passthrough',
  };
  const mappedType = typeMap[options.type];
  if (!mappedType) {
    return {
      valid: false,
      error: `Invalid type: ${options.type}. Valid options: ${validTypeList}`,
    };
  }
  options.type = mappedType;

  // --exclude-domains only applies to the web-search connector.
  if (options.excludeDomains && !(mappedType === 'connector' && options.connector === 'web-search')) {
    return {
      valid: false,
      error: '--exclude-domains only applies to --connector web-search',
    };
  }

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
    const project = await gatewayConfigIO.readProjectSpec();
    existingGateways = project.agentCoreGateways.map(g => g.name);
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
      const apiGwAuth = TARGET_TYPE_AUTH_CONFIG.apiGateway;
      const normalizedAuth = options.outboundAuthType.toUpperCase().replace('-', '_');
      if (!apiGwAuth.validAuthTypes.includes(normalizedAuth as 'OAUTH' | 'API_KEY' | 'NONE')) {
        return { valid: false, error: `${options.outboundAuthType} is not supported for api-gateway type` };
      }
      if (normalizedAuth === 'API_KEY' && !options.credentialName) {
        return { valid: false, error: '--credential-name is required with --outbound-auth api-key' };
      }
    }
    if (options.oauthClientId || options.oauthClientSecret || options.oauthDiscoveryUrl || options.oauthScopes) {
      return { valid: false, error: 'OAuth options are not applicable for api-gateway type' };
    }
    if (options.lambdaArn) {
      return { valid: false, error: '--lambda-arn is not applicable for api-gateway type' };
    }
    if (options.toolSchemaFile) {
      return { valid: false, error: '--tool-schema-file is not applicable for api-gateway type' };
    }
    options.language = 'Other';
    return { valid: true };
  }

  // Lambda Function ARN targets: validate early and return
  if (mappedType === 'lambdaFunctionArn') {
    if (!options.lambdaArn) {
      return { valid: false, error: '--lambda-arn is required for lambda-function-arn type' };
    }
    if (!options.toolSchemaFile) {
      return { valid: false, error: '--tool-schema-file is required for lambda-function-arn type' };
    }
    if (options.endpoint) {
      return { valid: false, error: '--endpoint is not applicable for lambda-function-arn type' };
    }
    if (options.host) {
      return { valid: false, error: '--host is not applicable for lambda-function-arn type' };
    }
    if (options.language && options.language !== 'Other') {
      return { valid: false, error: '--language is not applicable for lambda-function-arn type' };
    }
    if (options.restApiId) {
      return { valid: false, error: '--rest-api-id is not applicable for lambda-function-arn type' };
    }
    if (options.stage) {
      return { valid: false, error: '--stage is not applicable for lambda-function-arn type' };
    }
    if (options.toolFilterPath) {
      return { valid: false, error: '--tool-filter-path is not applicable for lambda-function-arn type' };
    }
    if (options.toolFilterMethods) {
      return { valid: false, error: '--tool-filter-methods is not applicable for lambda-function-arn type' };
    }
    if (options.outboundAuthType) {
      return { valid: false, error: '--outbound-auth is not applicable for lambda-function-arn type' };
    }
    if (options.credentialName) {
      return { valid: false, error: '--credential-name is not applicable for lambda-function-arn type' };
    }
    if (options.oauthClientId || options.oauthClientSecret || options.oauthDiscoveryUrl || options.oauthScopes) {
      return { valid: false, error: 'OAuth options are not applicable for lambda-function-arn type' };
    }

    const configRoot = findConfigRoot();
    const projectRoot = configRoot ? dirname(configRoot) : process.cwd();
    const resolvedPath = isAbsolute(options.toolSchemaFile)
      ? options.toolSchemaFile
      : join(projectRoot, options.toolSchemaFile);

    if (!existsSync(resolvedPath)) {
      return { valid: false, error: `Tool schema file not found: ${options.toolSchemaFile}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
    } catch {
      return { valid: false, error: `Tool schema file is not valid JSON: ${options.toolSchemaFile}` };
    }

    if (!Array.isArray(parsed)) {
      return { valid: false, error: 'Tool schema file must contain a JSON array' };
    }
    if (parsed.length === 0) {
      return { valid: false, error: 'Tool schema file must contain at least one tool definition' };
    }
    for (const [i, entry] of parsed.entries()) {
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name) {
        return { valid: false, error: `Tool schema entry ${i} is missing a valid "name" field` };
      }
      if (typeof item.description !== 'string' || !item.description) {
        return { valid: false, error: `Tool schema entry ${i} is missing a valid "description" field` };
      }
    }

    options.language = 'Other';
    return { valid: true };
  }

  // HTTP Runtime targets: validate early and return
  if (mappedType === 'httpRuntime') {
    if (!options.runtime) {
      return { valid: false, error: '--runtime is required for http-runtime type' };
    }
    if (options.language && options.language !== 'Other') {
      return { valid: false, error: '--language is not applicable for http-runtime type' };
    }

    const HTTP_RUNTIME_DISALLOWED_OPTIONS = [
      'host',
      'restApiId',
      'stage',
      'lambdaArn',
      'toolSchemaFile',
      'toolFilterPath',
      'toolFilterMethods',
      'schema',
    ] as const;

    for (const opt of HTTP_RUNTIME_DISALLOWED_OPTIONS) {
      if (options[opt]) {
        return {
          valid: false,
          error: `--${opt.replace(/([A-Z])/g, '-$1').toLowerCase()} is not applicable for http-runtime type`,
        };
      }
    }

    // Map --runtime-endpoint to the endpoint field used by createHttpRuntimeTarget
    if (options.runtimeEndpoint) {
      options.endpoint = options.runtimeEndpoint;
    }

    options.language = 'Other';
    return { valid: true };
  }

  // Connector targets (Bedrock KB, agentic-retrieve): validate early and return
  if (mappedType === 'connector') {
    const validConnectors = CONNECTOR_ID_VALUES.join(', ');
    if (!options.connector) {
      return {
        valid: false,
        error: `--connector is required for connector type. Valid: ${validConnectors}`,
      };
    }
    if (!(CONNECTOR_ID_VALUES as readonly string[]).includes(options.connector)) {
      return {
        valid: false,
        error: `Invalid --connector "${options.connector}". Valid: ${validConnectors}`,
      };
    }
    if (options.connector === 'web-search' && options.knowledgeBaseId && options.knowledgeBaseId.length > 0) {
      return {
        valid: false,
        error: '--knowledge-base-id is not applicable for --connector web-search',
      };
    }
    if (options.connector !== 'web-search' && (!options.knowledgeBaseId || options.knowledgeBaseId.length === 0)) {
      return {
        valid: false,
        error: `--knowledge-base-id is required for --connector ${options.connector}`,
      };
    }
    if (options.connector === 'bedrock-knowledge-bases' && (options.knowledgeBaseId?.length ?? 0) > 1) {
      return {
        valid: false,
        error: '--knowledge-base-id may only be specified once for --connector bedrock-knowledge-bases.',
      };
    }
    const irrelevant: [string, string][] = [
      ['endpoint', '--endpoint'],
      ['host', '--host'],
      ['restApiId', '--rest-api-id'],
      ['stage', '--stage'],
      ['lambdaArn', '--lambda-arn'],
      ['toolSchemaFile', '--tool-schema-file'],
      ['toolFilterPath', '--tool-filter-path'],
      ['toolFilterMethods', '--tool-filter-methods'],
      ['schema', '--schema'],
      ['schemaS3Account', '--schema-s3-account'],
      ['outboundAuthType', '--outbound-auth'],
      ['credentialName', '--credential-name'],
      ['oauthClientId', '--oauth-client-id'],
      ['oauthClientSecret', '--oauth-client-secret'],
      ['oauthDiscoveryUrl', '--oauth-discovery-url'],
      ['oauthScopes', '--oauth-scopes'],
    ];
    for (const [key, flag] of irrelevant) {
      if ((options as unknown as Record<string, unknown>)[key]) {
        return { valid: false, error: `${flag} is not applicable for connector type` };
      }
    }
    if (options.language && options.language !== 'Other') {
      return { valid: false, error: '--language is not applicable for connector type' };
    }
    options.language = 'Other';
    return { valid: true };
  }

  // Passthrough targets: validate early and return
  if (mappedType === 'passthrough') {
    const passthroughEndpoint = (options as Record<string, string | undefined>).passthroughEndpoint;
    if (!passthroughEndpoint) {
      return { valid: false, error: '--passthrough-endpoint is required for passthrough type' };
    }
    if (!/^https:\/\/[a-zA-Z0-9\-.]+(:[0-9]{1,5})?(\/.*)?$/.test(passthroughEndpoint)) {
      return { valid: false, error: '--passthrough-endpoint must be a valid HTTPS URL' };
    }
    if (options.language && options.language !== 'Other') {
      return { valid: false, error: '--language is not applicable for passthrough type' };
    }

    const PASSTHROUGH_DISALLOWED_OPTIONS = [
      'host',
      'restApiId',
      'stage',
      'lambdaArn',
      'toolSchemaFile',
      'toolFilterPath',
      'toolFilterMethods',
      'schema',
      'runtime',
      'runtimeEndpoint',
    ] as const;

    for (const opt of PASSTHROUGH_DISALLOWED_OPTIONS) {
      if (options[opt]) {
        return {
          valid: false,
          error: `--${opt.replace(/([A-Z])/g, '-$1').toLowerCase()} is not applicable for passthrough type`,
        };
      }
    }

    const stickinessTimeoutRaw = (options as Record<string, string | undefined>).stickinessTimeout;
    if (stickinessTimeoutRaw) {
      const timeout = parseInt(stickinessTimeoutRaw, 10);
      if (isNaN(timeout) || timeout < 1 || timeout > 86400) {
        return { valid: false, error: '--stickiness-timeout must be a number between 1 and 86400' };
      }
    }

    // Validate outbound auth for passthrough
    if (options.outboundAuthType) {
      const normalizedAuth = options.outboundAuthType.toUpperCase().replace(/-/g, '_');
      if (normalizedAuth === 'GATEWAY_IAM_ROLE') {
        // signingService validation is done in the primitive action handler
      } else if (normalizedAuth === 'JWT_PASSTHROUGH') {
        // No additional fields required
      } else if (normalizedAuth === 'OAUTH') {
        if (!options.credentialName) {
          const hasInlineOAuth = !!(options.oauthClientId ?? options.oauthClientSecret ?? options.oauthDiscoveryUrl);
          if (!hasInlineOAuth) {
            return { valid: false, error: '--credential-name or inline OAuth fields required for OAUTH auth' };
          }
        }
      } else if (normalizedAuth !== 'NONE') {
        return { valid: false, error: `Unsupported outbound auth type for passthrough: ${options.outboundAuthType}` };
      }
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

  // Schema-based targets (OpenAPI / Smithy)
  if (mappedType === 'openApiSchema' || mappedType === 'smithyModel') {
    if (!options.schema) {
      return { valid: false, error: '--schema is required for schema-based target types' };
    }
    if (options.endpoint) {
      return { valid: false, error: `--endpoint is not applicable for ${mappedType} target type` };
    }
    if (options.host) {
      return { valid: false, error: `--host is not applicable for ${mappedType} target type` };
    }

    // Auth validation from centralized config
    const authConfig = TARGET_TYPE_AUTH_CONFIG[mappedType as keyof typeof TARGET_TYPE_AUTH_CONFIG];
    const providedAuth = options.outboundAuthType ?? 'NONE';
    if (authConfig.authRequired && providedAuth === 'NONE') {
      return {
        valid: false,
        error: `${mappedType} targets require outbound auth (${authConfig.validAuthTypes.join(' or ')})`,
      };
    }
    if (authConfig.validAuthTypes.length === 0 && providedAuth !== 'NONE') {
      return {
        valid: false,
        error: `${mappedType} targets use IAM role auth; --outbound-auth is not applicable`,
      };
    }

    const isS3 = options.schema.startsWith('s3://');
    if (isS3) {
      // Validate S3 URI format: s3://bucket/key
      const s3Path = options.schema.slice(5); // strip 's3://'
      if (!s3Path.includes('/') || s3Path.startsWith('/')) {
        return { valid: false, error: 'Invalid S3 URI format. Expected: s3://bucket-name/key' };
      }
    } else {
      // Local file validation — resolve relative to project root (parent of agentcore/)
      const configRoot = findConfigRoot();
      const projectRoot = configRoot ? dirname(configRoot) : undefined;
      const resolvedPath = projectRoot ? join(projectRoot, options.schema) : resolve(options.schema);
      if (!existsSync(resolvedPath)) {
        return {
          valid: false,
          error: projectRoot
            ? `Schema file not found: ${options.schema} (resolved to ${resolvedPath}). Path should be relative to the project root.`
            : `Schema file not found: ${options.schema}`,
        };
      }
      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.json') {
        return { valid: false, error: `Schema file must be a JSON file (.json), got: ${ext}` };
      }
    }

    if (options.schemaS3Account && !isS3) {
      return { valid: false, error: '--schema-s3-account is only valid with S3 URIs' };
    }

    options.language = 'Other';
    return { valid: true };
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

    if (options.lambdaArn) {
      return { valid: false, error: '--lambda-arn is not applicable for mcp-server type' };
    }
    if (options.toolSchemaFile) {
      return { valid: false, error: '--tool-schema-file is not applicable for mcp-server type' };
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

  if (options.indexedKey && options.indexedKey.length > 0) {
    const ltmStrategies = (options.strategies ?? '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    if (ltmStrategies.length === 0) {
      return {
        valid: false,
        error:
          '--indexed-key requires at least one long-term memory strategy (--strategies). Indexed keys filter long-term memory records on retrieval.',
      };
    }

    if (options.indexedKey.length > MAX_INDEXED_KEYS) {
      return { valid: false, error: `Maximum ${MAX_INDEXED_KEYS} indexed keys allowed` };
    }

    const seenKeys = new Set<string>();
    for (const raw of options.indexedKey) {
      const result = parseIndexedKeyArg(raw);
      if (!result.ok) {
        return { valid: false, error: result.error };
      }
      const { key } = result.value;
      if (seenKeys.has(key)) {
        return { valid: false, error: `Duplicate indexed key: "${key}"` };
      }
      seenKeys.add(key);
    }
  }

  if (options.streamDeliveryResources && (options.dataStreamArn || options.contentLevel || options.deliveryType)) {
    return {
      valid: false,
      error:
        '--stream-delivery-resources cannot be combined with --data-stream-arn, --stream-content-level, or --delivery-type',
    };
  }

  if (options.contentLevel && !options.dataStreamArn) {
    return { valid: false, error: '--data-stream-arn is required when --stream-content-level is set' };
  }

  if (options.deliveryType && !options.dataStreamArn) {
    return { valid: false, error: '--data-stream-arn is required when --delivery-type is set' };
  }

  if (options.dataStreamArn && !isValidArn(options.dataStreamArn)) {
    return { valid: false, error: `--data-stream-arn: ${ARN_VALIDATION_MESSAGE}` };
  }

  if (
    options.deliveryType &&
    !VALID_DELIVERY_TYPES.includes(options.deliveryType as (typeof VALID_DELIVERY_TYPES)[number])
  ) {
    return {
      valid: false,
      error: `Invalid delivery type. Must be one of: ${VALID_DELIVERY_TYPES.join(', ')}`,
    };
  }

  if (options.contentLevel && !VALID_STREAM_CONTENT_LEVELS.includes(options.contentLevel)) {
    return {
      valid: false,
      error: `Invalid content level. Must be one of: ${VALID_STREAM_CONTENT_LEVELS.join(', ')}`,
    };
  }

  if (options.streamDeliveryResources) {
    try {
      StreamDeliveryResourcesSchema.parse(JSON.parse(options.streamDeliveryResources));
    } catch (e) {
      return {
        valid: false,
        error:
          e instanceof SyntaxError
            ? 'Invalid JSON in --stream-delivery-resources'
            : 'Invalid --stream-delivery-resources: does not match the expected schema',
      };
    }
  }

  return { valid: true };
}

// Dataset validation
export function validateAddDatasetOptions(options: AddDatasetOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const nameResult = DatasetNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid dataset name' };
  }

  if (!options.schemaType) {
    return { valid: false, error: '--schema-type is required' };
  }

  const schemaTypeResult = DatasetSchemaTypeSchema.safeParse(options.schemaType);
  if (!schemaTypeResult.success) {
    const valid = DatasetSchemaTypeSchema.options.join(', ');
    return { valid: false, error: `Invalid schema type: ${options.schemaType}. Valid options: ${valid}` };
  }

  if (options.kmsKeyArn && !isValidKmsKeyArn(options.kmsKeyArn)) {
    return {
      valid: false,
      error:
        '--kms-key-arn must be a valid KMS key ARN (e.g. arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)',
    };
  }

  return { valid: true };
}

// Credential validation (v2: credential resource, no owner)
export function validateAddCredentialOptions(options: AddCredentialOptions): ValidationResult {
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

const VALID_HARNESS_TOOLS = [
  'agentcore_browser',
  'agentcore_code_interpreter',
  'remote_mcp',
  'agentcore_gateway',
] as const;

const VALID_GATEWAY_OUTBOUND_AUTH = ['awsIam', 'none', 'oauth'] as const;

const VALID_MEMORY_MODES = ['managed', 'existing', 'disabled'] as const;
// Managed harness memory excludes CUSTOM (only the four; CUSTOM is for standalone memory).
const VALID_MANAGED_STRATEGIES = ['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC'] as const;

export function validateAddHarnessOptions(options: AddHarnessCliOptions): ValidationResult {
  if (options.apiFormat) {
    const provider = options.modelProvider ?? 'bedrock';
    const formatResult = validateApiFormat(options.apiFormat, provider);
    if (!formatResult.valid) {
      return { valid: false, error: formatResult.error };
    }
  }

  // VPC network-mode coupling: reject --subnets/--security-groups when network mode isn't VPC
  // (and require them when it is), instead of silently dropping them. Mirrors the agent path.
  // Any --container value is a container build — a dockerfile path AND a prebuilt image URI both run
  // CodeBuild (a URI export emits a `FROM <uri>` Dockerfile stub), so both require --vpc-id in VPC
  // mode. Gating on a dockerfile-only heuristic let a `--container <ecr-uri>` VPC harness persist
  // without a vpcId and then dead-end at deploy/export.
  const harnessBuildType = options.container ? 'Container' : undefined;
  const vpcResult = validateVpcOptions(options, harnessBuildType);
  if (!vpcResult.valid) {
    return vpcResult;
  }

  if (options.tools) {
    const toolNames = options.tools.split(',').map(s => s.trim());
    for (const tool of toolNames) {
      if (!VALID_HARNESS_TOOLS.includes(tool as (typeof VALID_HARNESS_TOOLS)[number])) {
        return {
          valid: false,
          error: `Unknown tool '${tool}'. Valid tools: ${VALID_HARNESS_TOOLS.join(', ')}`,
        };
      }
    }

    if (toolNames.includes('remote_mcp')) {
      if (!options.mcpName) {
        return { valid: false, error: '--mcp-name is required when --tools includes remote_mcp' };
      }
      if (!options.mcpUrl) {
        return { valid: false, error: '--mcp-url is required when --tools includes remote_mcp' };
      }
    }

    if (toolNames.includes('agentcore_gateway')) {
      if (!options.gatewayArn) {
        return { valid: false, error: '--gateway-arn is required when --tools includes agentcore_gateway' };
      }
    }
  }

  if (options.gatewayOutboundAuth) {
    if (
      !VALID_GATEWAY_OUTBOUND_AUTH.includes(options.gatewayOutboundAuth as (typeof VALID_GATEWAY_OUTBOUND_AUTH)[number])
    ) {
      return {
        valid: false,
        error: `Invalid --gateway-outbound-auth '${options.gatewayOutboundAuth}'. Use: ${VALID_GATEWAY_OUTBOUND_AUTH.join(', ')}`,
      };
    }

    if (options.gatewayOutboundAuth === 'oauth') {
      if (!options.gatewayProviderArn) {
        return { valid: false, error: '--gateway-provider-arn is required when --gateway-outbound-auth is oauth' };
      }
      if (!options.gatewayScopes) {
        return { valid: false, error: '--gateway-scopes is required when --gateway-outbound-auth is oauth' };
      }
    }
  }

  // --gateway-grant-type / --gateway-custom-parameters only live on the oauth arm; reject them for
  // any other (or absent) outbound-auth rather than silently dropping them at spec-build.
  if (
    (options.gatewayGrantType !== undefined || options.gatewayCustomParameters !== undefined) &&
    options.gatewayOutboundAuth !== 'oauth'
  ) {
    return {
      valid: false,
      error: '--gateway-grant-type and --gateway-custom-parameters are only valid with --gateway-outbound-auth oauth',
    };
  }

  // Memory flag coupling. Commander sets `memory` to false for --no-memory.
  const noMemory = options.memory === false;
  const memoryTuningGiven =
    options.memoryActorId !== undefined ||
    options.memoryMessagesCount !== undefined ||
    options.memoryTopK !== undefined ||
    options.memoryRelevanceScore !== undefined;
  // Managed-only knobs (strategies/event-expiry/KMS) describe a managed memory; they are meaningless
  // with --no-memory (which produces disabled memory) and on non-managed modes.
  const managedOnlyFlags =
    options.memoryStrategies !== undefined ||
    options.memoryEventExpiryDays !== undefined ||
    options.memoryEncryptionKeyArn !== undefined;
  if (options.memoryArn && options.memoryName) {
    return { valid: false, error: '--memory-arn and --memory-name are mutually exclusive' };
  }
  if (options.memoryArn && !isValidArn(options.memoryArn)) {
    return { valid: false, error: `--memory-arn: ${ARN_VALIDATION_MESSAGE}` };
  }
  if (noMemory && (options.memoryArn || options.memoryName || memoryTuningGiven || managedOnlyFlags)) {
    return {
      valid: false,
      error:
        '--no-memory cannot be combined with --memory-arn, --memory-name, memory tuning flags, or managed-memory flags (--memory-strategies, --memory-event-expiry-days, --memory-encryption-key-arn)',
    };
  }

  // Managed-memory mode validation.
  if (options.memoryMode && !VALID_MEMORY_MODES.includes(options.memoryMode as (typeof VALID_MEMORY_MODES)[number])) {
    return {
      valid: false,
      error: `Invalid --memory-mode '${options.memoryMode}'. Use ${VALID_MEMORY_MODES.join(', ')}.`,
    };
  }
  if (noMemory && (options.memoryMode === 'managed' || options.memoryMode === 'existing')) {
    return { valid: false, error: '--no-memory cannot be combined with --memory-mode managed/existing' };
  }
  if (options.memoryMode === 'existing' && !options.memoryArn && !options.memoryName) {
    return { valid: false, error: '--memory-mode existing requires --memory-arn or --memory-name' };
  }
  // A memory reference (--memory-arn/--memory-name) is an `existing` selector. It is contradictory
  // with an explicit managed or disabled mode — reject rather than silently downgrading to existing.
  if (
    (options.memoryArn || options.memoryName) &&
    (options.memoryMode === 'managed' || options.memoryMode === 'disabled')
  ) {
    return {
      valid: false,
      error: `--memory-arn/--memory-name reference an existing memory and cannot be combined with --memory-mode ${options.memoryMode}`,
    };
  }
  // Existing-only retrieval tuning (actorId/messagesCount/topK/relevanceScore) only applies to an
  // existing memory. Given without an existing reference it would be silently dropped — require the ref.
  if (memoryTuningGiven && !options.memoryArn && !options.memoryName && options.memoryMode !== 'existing') {
    return {
      valid: false,
      error:
        'memory tuning flags (--memory-actor-id, --memory-messages-count, --memory-top-k, --memory-relevance-score) require an existing memory (--memory-arn, --memory-name, or --memory-mode existing)',
    };
  }
  if (managedOnlyFlags && options.memoryMode && options.memoryMode !== 'managed') {
    return {
      valid: false,
      error:
        '--memory-strategies, --memory-event-expiry-days, and --memory-encryption-key-arn are only valid with --memory-mode managed',
    };
  }
  if (options.memoryStrategies) {
    const bad = options.memoryStrategies
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !VALID_MANAGED_STRATEGIES.includes(s as (typeof VALID_MANAGED_STRATEGIES)[number]));
    if (bad.length) {
      return {
        valid: false,
        error: `Invalid managed memory strateg${bad.length > 1 ? 'ies' : 'y'}: ${bad.join(', ')}. Valid: ${VALID_MANAGED_STRATEGIES.join(', ')}`,
      };
    }
  }

  if (options.authorizerType) {
    const authResult = RuntimeAuthorizerTypeSchema.safeParse(options.authorizerType);
    if (!authResult.success) {
      return { valid: false, error: 'Invalid authorizer type. Use AWS_IAM or CUSTOM_JWT' };
    }

    if (options.authorizerType === 'CUSTOM_JWT') {
      const jwtResult = validateJwtAuthorizerOptions(options);
      if (!jwtResult.valid) return jwtResult;
    }
  }

  if (options.clientId && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: 'OAuth client credentials are only valid with CUSTOM_JWT authorizer' };
  }

  // PrivateLink (private-endpoint) flags only apply to the CUSTOM_JWT inbound authorizer; reject
  // them for any other authorizer rather than silently dropping the config (mirrors the OAuth guard).
  const hasPrivateEndpointFlag = [
    options.privateEndpointLatticeArn,
    options.privateEndpointVpcId,
    options.privateEndpointSubnets,
    options.privateEndpointIpType,
    options.privateEndpointSecurityGroups,
    options.privateEndpointRoutingDomain,
    options.privateEndpointTags,
    options.privateEndpointOverrides,
  ].some(Boolean);
  if (hasPrivateEndpointFlag && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: '--private-endpoint-* flags are only valid with CUSTOM_JWT authorizer' };
  }

  return { valid: true };
}
