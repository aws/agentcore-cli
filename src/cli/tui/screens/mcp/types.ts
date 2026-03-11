import type {
  ApiGatewayHttpMethod,
  GatewayAuthorizerType,
  GatewayTargetType,
  NodeRuntime,
  PythonRuntime,
  SchemaSource,
  ToolDefinition,
} from '../../../../schema';
import { TARGET_TYPE_AUTH_CONFIG } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddGatewayStep = 'name' | 'authorizer' | 'jwt-config' | 'include-targets' | 'advanced-config' | 'confirm';

export interface AddGatewayConfig {
  name: string;
  description: string;
  /** Authorization type for the gateway */
  authorizerType: GatewayAuthorizerType;
  /** JWT authorizer configuration (when authorizerType is 'CUSTOM_JWT') */
  jwtConfig?: {
    discoveryUrl: string;
    allowedAudience: string[];
    allowedClients: string[];
    allowedScopes?: string[];
    agentClientId?: string;
    agentClientSecret?: string;
  };
  /** Selected unassigned targets to include in this gateway */
  selectedTargets?: string[];
  /** Whether to enable semantic search for tool discovery */
  enableSemanticSearch: boolean;
}

/** Item ID for the semantic search toggle in the advanced config pane. */
export const SEMANTIC_SEARCH_ITEM_ID = 'semantic-search';

export const GATEWAY_STEP_LABELS: Record<AddGatewayStep, string> = {
  name: 'Name',
  authorizer: 'Authorizer',
  'jwt-config': 'JWT Config',
  'include-targets': 'Include Targets',
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
    type: 'OAUTH' | 'API_KEY' | 'NONE';
    credentialName?: string;
    scopes?: string[];
  };
  restApiId?: string;
  stage?: string;
  toolFilters?: { filterPath: string; methods: ApiGatewayHttpMethod[] }[];
  /** Schema source for openApiSchema / smithyModel targets */
  schemaSource?: SchemaSource;
  lambdaArn?: string;
  toolSchemaFile?: string;
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

export type AddGatewayTargetConfig =
  | McpServerTargetConfig
  | ApiGatewayTargetConfig
  | SchemaBasedTargetConfig
  | LambdaFunctionArnTargetConfig;

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

export const TARGET_TYPE_OPTIONS = [
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

export const PYTHON_VERSION_OPTIONS = [
  { id: 'PYTHON_3_13', title: 'Python 3.13', description: 'Latest' },
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

export const DEFAULT_PYTHON_VERSION: PythonRuntime = 'PYTHON_3_13';
export const DEFAULT_NODE_VERSION: NodeRuntime = 'NODE_20';
export const DEFAULT_HANDLER = 'handler.lambda_handler';
