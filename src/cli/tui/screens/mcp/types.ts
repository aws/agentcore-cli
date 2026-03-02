import type { GatewayAuthorizerType, NodeRuntime, PythonRuntime, ToolDefinition } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddGatewayStep = 'name' | 'authorizer' | 'jwt-config' | 'include-targets' | 'confirm';

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
}

export const GATEWAY_STEP_LABELS: Record<AddGatewayStep, string> = {
  name: 'Name',
  authorizer: 'Authorizer',
  'jwt-config': 'JWT Config',
  'include-targets': 'Include Targets',
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
  | 'source'
  | 'endpoint'
  | 'language'
  | 'gateway'
  | 'host'
  | 'outbound-auth'
  | 'confirm';

export type TargetLanguage = 'Python' | 'TypeScript' | 'Other';

export interface AddGatewayTargetConfig {
  name: string;
  description: string;
  sourcePath: string;
  language: TargetLanguage;
  /** Source type for external endpoints */
  source?: 'existing-endpoint' | 'create-new';
  /** External endpoint URL */
  endpoint?: string;
  /** Gateway name */
  gateway?: string;
  /** Compute host (Lambda or AgentCoreRuntime) */
  host: ComputeHost;
  /** Derived tool definition */
  toolDefinition: ToolDefinition;
  /** Outbound auth configuration */
  outboundAuth?: {
    type: 'OAUTH' | 'API_KEY' | 'NONE';
    credentialName?: string;
    scopes?: string[];
  };
}

export const MCP_TOOL_STEP_LABELS: Record<AddGatewayTargetStep, string> = {
  name: 'Name',
  source: 'Source',
  endpoint: 'Endpoint',
  language: 'Language',
  gateway: 'Gateway',
  host: 'Host',
  'outbound-auth': 'Outbound Auth',
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

export const SOURCE_OPTIONS = [
  { id: 'existing-endpoint', title: 'Existing endpoint', description: 'Connect to an existing MCP server' },
  { id: 'create-new', title: 'Create new', description: 'Scaffold a new MCP server' },
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

export const OUTBOUND_AUTH_OPTIONS = [
  { id: 'NONE', title: 'No authorization', description: 'No outbound authentication' },
  { id: 'OAUTH', title: 'OAuth 2LO', description: 'OAuth 2.0 client credentials' },
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
