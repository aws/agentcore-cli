import type {
  ApiGatewayHttpMethod,
  CustomClaimValidation,
  GatewayAuthorizerType,
  GatewayExceptionLevel,
  GatewayPolicyEngineConfiguration,
  GatewayTargetType,
  NodeRuntime,
  PassthroughProtocolType,
  SchemaSource,
  ToolDefinition,
} from '../../../../schema';
import { TARGET_TYPE_AUTH_CONFIG } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddGatewayStep =
  | 'name'
  | 'authorizer'
  | 'jwt-config'
  | 'include-targets'
  | 'policy-engine'
  | 'advanced-config'
  | 'confirm';

export interface AddGatewayConfig {
  name: string;
  description: string;
  /** Protocol type for the gateway. Omit for MCP (default). */
  protocolType?: 'MCP' | 'None';
  /** Authorization type for the gateway */
  authorizerType: GatewayAuthorizerType;
  /** JWT authorizer configuration (when authorizerType is 'CUSTOM_JWT') */
  jwtConfig?: {
    discoveryUrl: string;
    allowedAudience?: string[];
    allowedClients?: string[];
    allowedScopes?: string[];
    customClaims?: CustomClaimValidation[];
    clientId?: string;
    clientSecret?: string;
  };
  /** Selected unassigned targets to include in this gateway */
  selectedTargets?: string[];
  /** Whether to enable semantic search for tool discovery */
  enableSemanticSearch: boolean;
  /** Exception verbosity level for the gateway */
  exceptionLevel: GatewayExceptionLevel;
  /** Policy engine configuration for Cedar-based authorization */
  policyEngineConfiguration?: GatewayPolicyEngineConfiguration;
}

/** Item ID for the semantic search toggle in the advanced config pane. */
export const SEMANTIC_SEARCH_ITEM_ID = 'semantic-search';

/** Item ID for the debug exception level toggle in the advanced config pane. */
export const EXCEPTION_LEVEL_ITEM_ID = 'exception-level';

export const GATEWAY_STEP_LABELS: Record<AddGatewayStep, string> = {
  name: 'Name',
  authorizer: 'Authorizer',
  'jwt-config': 'JWT Config',
  'include-targets': 'Include Targets',
  'policy-engine': 'Policy Engine',
  'advanced-config': 'Advanced',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Target Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type ComputeHost = 'Lambda' | 'AgentCoreRuntime';

/**
 * Gateway target wizard steps.
 * - name: Tool name input
 * - language: Target language (Python or TypeScript)
 * - gateway: Select existing gateway
 * - host: Select compute host
 * - confirm: Review and confirm
 */
export type AddGatewayTargetStep =
  | 'name'
  | 'target-type'
  | 'endpoint'
  | 'language'
  | 'gateway'
  | 'host'
  | 'outbound-auth'
  | 'rest-api-id'
  | 'stage'
  | 'tool-filters'
  | 'api-gateway-auth'
  | 'schema-source'
  | 'lambda-arn'
  | 'tool-schema'
  | 'runtime'
  | 'runtime-endpoint'
  | 'kb-select'
  | 'kb-id'
  | 'passthrough-endpoint'
  | 'passthrough-protocol'
  | 'passthrough-stickiness'
  | 'signing-service'
  | 'signing-region'
  | 'exclude-domains'
  | 'confirm';

export type TargetLanguage = 'Python' | 'TypeScript' | 'Other';

/**
 * Wizard-internal state — all fields optional, built incrementally as the user
 * progresses through wizard steps. Not used outside the wizard/screen boundary.
 */
export interface GatewayTargetWizardState {
  name: string;
  description?: string;
  sourcePath?: string;
  language?: TargetLanguage;
  targetType?: GatewayTargetType;
  endpoint?: string;
  gateway?: string;
  host?: ComputeHost;
  toolDefinition?: ToolDefinition;
  outboundAuth?: {
    type: 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH';
    credentialName?: string;
    scopes?: string[];
    service?: string;
    region?: string;
  };
  restApiId?: string;
  stage?: string;
  toolFilters?: { filterPath: string; methods: ApiGatewayHttpMethod[] }[];
  /** Schema source for openApiSchema / smithyModel targets */
  schemaSource?: SchemaSource;
  lambdaArn?: string;
  toolSchemaFile?: string;
  /** Runtime name reference for httpRuntime targets */
  runtime?: string;
  /** Knowledge Base reference for connector targets — either a project KB name or a literal 10-char KB ID. */
  knowledgeBaseId?: string;
  /**
   * Connector identifier when targetType is 'connector'. Only
   * `bedrock-knowledge-bases` is exposed in the TUI; `bedrock-agentic-retrieve`
   * is gateway-managed by the Add Knowledge Base flow.
   */
  connectorId?: 'bedrock-knowledge-bases' | 'bedrock-agentic-retrieve';
  /** Passthrough endpoint URL for passthrough targets */
  passthroughEndpoint?: string;
  /** Passthrough protocol type for passthrough targets */
  passthroughProtocol?: PassthroughProtocolType;
  /** Stickiness routing identifier for passthrough targets */
  stickinessIdentifier?: string;
  /** Stickiness timeout in seconds for passthrough targets */
  stickinessTimeout?: number;
  /** SigV4 signing service for passthrough GATEWAY_IAM_ROLE auth */
  signingService?: string;
  /** SigV4 signing region for passthrough GATEWAY_IAM_ROLE auth */
  signingRegion?: string;
  /** Optional list of domains to exclude (webSearch target type only). */
  excludeDomains?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union — fully-formed configs passed downstream of the wizard.
// Each variant has required fields for its target type.
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerTargetConfig {
  targetType: 'mcpServer';
  name: string;
  description: string;
  endpoint: string;
  gateway: string;
  toolDefinition: ToolDefinition;
  outboundAuth?: {
    type: 'OAUTH' | 'API_KEY' | 'NONE';
    credentialName?: string;
    scopes?: string[];
  };
}

export interface ApiGatewayTargetConfig {
  targetType: 'apiGateway';
  name: string;
  gateway: string;
  restApiId: string;
  stage: string;
  toolFilters?: { filterPath: string; methods: ApiGatewayHttpMethod[] }[];
  outboundAuth?: {
    type: 'API_KEY' | 'NONE';
    credentialName?: string;
  };
}

export interface SchemaBasedTargetConfig {
  targetType: 'openApiSchema' | 'smithyModel';
  name: string;
  gateway: string;
  schemaSource: SchemaSource;
  outboundAuth?: {
    type: 'OAUTH' | 'API_KEY' | 'NONE';
    credentialName?: string;
    scopes?: string[];
  };
}

export interface LambdaFunctionArnTargetConfig {
  targetType: 'lambdaFunctionArn';
  name: string;
  gateway: string;
  lambdaArn: string;
  toolSchemaFile: string;
}

export interface HttpRuntimeTargetConfig {
  targetType: 'httpRuntime';
  name: string;
  gateway: string;
  runtime: string;
  endpoint?: string;
  outboundAuth?: { type: string; credentialName?: string; scopes?: string[] };
}

interface ConnectorTargetConfigBase {
  targetType: 'connector';
  name: string;
  gateway: string;
  description?: string;
}

export interface BedrockKnowledgeBasesConnectorTargetConfig extends ConnectorTargetConfigBase {
  connectorId: 'bedrock-knowledge-bases';
  /**
   * Either a project KB name (a knowledgeBases[] entry, resolved at synth
   * via application.knowledgeBases) or a literal 10-char external KB ID.
   */
  knowledgeBaseId: string;
}

export interface BedrockAgenticRetrieveConnectorTargetConfig extends ConnectorTargetConfigBase {
  connectorId: 'bedrock-agentic-retrieve';
  /** Fan-out: project KB names and/or literal 10-char external KB IDs. */
  knowledgeBaseIds: string[];
}

export type ConnectorTargetConfig =
  | BedrockKnowledgeBasesConnectorTargetConfig
  | BedrockAgenticRetrieveConnectorTargetConfig;

export interface PassthroughTargetConfig {
  targetType: 'passthrough';
  name: string;
  gateway: string;
  passthroughEndpoint: string;
  protocolType?: PassthroughProtocolType;
  stickinessIdentifier?: string;
  stickinessTimeout?: number;
  outboundAuth?: {
    type: 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH';
    credentialName?: string;
    scopes?: string[];
    service?: string;
    region?: string;
  };
}

export interface WebSearchTargetConfig {
  targetType: 'webSearch';
  name: string;
  gateway: string;
  /** Optional list of domains to exclude from web search results. */
  excludeDomains?: string[];
}

export type AddGatewayTargetConfig =
  | McpServerTargetConfig
  | ApiGatewayTargetConfig
  | SchemaBasedTargetConfig
  | LambdaFunctionArnTargetConfig
  | HttpRuntimeTargetConfig
  | ConnectorTargetConfig
  | PassthroughTargetConfig
  | WebSearchTargetConfig;

export const MCP_TOOL_STEP_LABELS: Record<AddGatewayTargetStep, string> = {
  name: 'Name',
  'target-type': 'Target Type',
  endpoint: 'Endpoint',
  language: 'Language',
  gateway: 'Gateway',
  host: 'Host',
  'outbound-auth': 'Outbound Auth',
  'rest-api-id': 'REST API ID',
  stage: 'Stage',
  'tool-filters': 'Tool Filters',
  'api-gateway-auth': 'Authorization',
  'schema-source': 'Schema Source',
  'lambda-arn': 'Lambda ARN',
  'tool-schema': 'Tool Schema File',
  runtime: 'Runtime',
  'runtime-endpoint': 'Endpoint',
  'kb-select': 'Knowledge Base',
  'kb-id': 'KB ID',
  'passthrough-endpoint': 'Endpoint',
  'passthrough-protocol': 'Protocol',
  'passthrough-stickiness': 'Stickiness',
  'signing-service': 'Signing Service',
  'signing-region': 'Signing Region',
  'exclude-domains': 'Exclude Domains',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AUTHORIZER_TYPE_OPTIONS = [
  { id: 'AWS_IAM', title: 'AWS IAM', description: 'AWS Identity and Access Management authorization' },
  { id: 'CUSTOM_JWT', title: 'Custom JWT', description: 'JWT-based authorization via OIDC provider' },
  { id: 'NONE', title: 'None', description: 'No authorization required — gateway is publicly accessible' },
] as const;

export const SKIP_FOR_NOW = 'skip-for-now' as const;

/** Sentinel ID for "no selection" in select lists (e.g., no policy engine). */
export const NONE_SELECTION = '__none__' as const;

export const TARGET_TYPE_OPTIONS = [
  // MCP targets
  { id: 'mcpServer', title: 'MCP Server endpoint', description: 'Connect to an existing MCP-compatible server' },
  {
    id: 'apiGateway',
    title: 'API Gateway REST API',
    description: 'Connect to an existing Amazon API Gateway REST API',
  },
  { id: 'openApiSchema', title: 'OpenAPI Schema', description: 'Auto-derive tools from an OpenAPI JSON spec' },
  { id: 'smithyModel', title: 'Smithy Model', description: 'Auto-derive tools from a Smithy JSON model' },
  {
    id: 'lambdaFunctionArn',
    title: 'Lambda function',
    description: 'Connect to an existing AWS Lambda function',
  },
  // HTTP targets
  {
    id: 'httpRuntime',
    title: 'HTTP Runtime',
    description: 'Route HTTP traffic to an AgentCore runtime',
  },
  {
    id: 'connector',
    title: 'Knowledge Base',
    description: 'Wire an existing Knowledge Base to this gateway as a connector target',
  },
  {
    id: 'passthrough',
    title: 'Passthrough',
    description: 'Route to external HTTPS endpoint',
  },
  {
    id: 'webSearch',
    title: 'Amazon Web Search',
    description: 'Wire the Amazon Web Search managed connector to this gateway',
  },
] as const;

/** Sentinel ID for the "Enter an existing KB ID manually..." option in the KB-select step. */
export const ENTER_KB_ID_MANUALLY = '__enter_kb_id__' as const;

/** Passthrough protocol options. CUSTOM is the default (first). */
export const PASSTHROUGH_PROTOCOL_OPTIONS = [
  { id: 'CUSTOM', title: 'CUSTOM', description: 'Generic HTTP/REST endpoint (default)' },
  { id: 'MCP', title: 'MCP', description: 'Model Context Protocol server' },
  { id: 'A2A', title: 'A2A', description: 'Agent-to-Agent protocol' },
  { id: 'INFERENCE', title: 'INFERENCE', description: 'Model inference endpoint' },
] as const;

export const TARGET_LANGUAGE_OPTIONS = [
  { id: 'Python', title: 'Python', description: 'FastMCP Python server' },
  { id: 'TypeScript', title: 'TypeScript', description: 'MCP TypeScript server' },
  { id: 'Other', title: 'Other', description: 'Container-based implementation' },
] as const;

export const COMPUTE_HOST_OPTIONS = [
  { id: 'Lambda', title: 'Lambda', description: 'AWS Lambda function' },
  { id: 'AgentCoreRuntime', title: 'AgentCore Runtime', description: 'AgentCore Runtime (Python only)' },
] as const;

/** All possible outbound auth UI options, keyed by auth type. */
const AUTH_OPTION_LABELS = {
  NONE: { title: 'No authorization', description: 'No outbound authentication' },
  OAUTH: { title: 'OAuth 2LO', description: 'OAuth 2.0 client credentials' },
  API_KEY: { title: 'API Key', description: 'API key credential' },
  GATEWAY_IAM_ROLE: { title: 'Gateway IAM Role', description: 'Gateway signs with SigV4' },
  JWT_PASSTHROUGH: { title: 'JWT Passthrough', description: 'Forward caller JWT token' },
} as const;

/** Derive the outbound auth UI options for a given target type from the centralized config. */
export function getOutboundAuthOptions(
  targetType: GatewayTargetType
): { id: string; title: string; description: string }[] {
  const config = TARGET_TYPE_AUTH_CONFIG[targetType];
  return config.validAuthTypes.map(id => ({
    id,
    title: AUTH_OPTION_LABELS[id].title,
    description: AUTH_OPTION_LABELS[id].description,
  }));
}

export const OUTBOUND_AUTH_OPTIONS = getOutboundAuthOptions('mcpServer');

export const API_GATEWAY_AUTH_OPTIONS = [
  { id: 'IAM', title: 'IAM (recommended)', description: 'AWS IAM role-based authorization' },
  { id: 'API_KEY', title: 'API Key', description: 'API key credential' },
  { id: 'NONE', title: 'No authorization', description: 'No outbound authentication' },
] as const;

export const POLICY_ENGINE_MODE_OPTIONS = [
  { id: 'LOG_ONLY', title: 'Log Only', description: 'Log policy decisions without enforcing' },
  { id: 'ENFORCE', title: 'Enforce', description: 'Enforce policy decisions and block unauthorized actions' },
] as const;

export const PYTHON_VERSION_OPTIONS = [
  { id: 'PYTHON_3_14', title: 'Python 3.14', description: 'Latest' },
  { id: 'PYTHON_3_13', title: 'Python 3.13', description: '' },
  { id: 'PYTHON_3_12', title: 'Python 3.12', description: '' },
  { id: 'PYTHON_3_11', title: 'Python 3.11', description: '' },
  { id: 'PYTHON_3_10', title: 'Python 3.10', description: '' },
] as const;

export const NODE_VERSION_OPTIONS = [
  { id: 'NODE_22', title: 'Node.js 22', description: 'Latest' },
  { id: 'NODE_20', title: 'Node.js 20', description: 'LTS' },
  { id: 'NODE_18', title: 'Node.js 18', description: '' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export { DEFAULT_PYTHON_VERSION } from '../../../../schema';
export const DEFAULT_NODE_VERSION: NodeRuntime = 'NODE_20';
export const DEFAULT_HANDLER = 'handler.lambda_handler';
