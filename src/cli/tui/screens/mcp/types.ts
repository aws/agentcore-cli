import type { GatewayAuthorizerType, NodeRuntime, PythonRuntime, ToolDefinition } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddGatewayStep = 'name' | 'authorizer' | 'jwt-config' | 'agents' | 'confirm';

export interface AddGatewayConfig {
  name: string;
  description: string;
  /** Agent names that will use this gateway */
  agents: string[];
  /** Authorization type for the gateway */
  authorizerType: GatewayAuthorizerType;
  /** JWT authorizer configuration (when authorizerType is 'CUSTOM_JWT') */
  jwtConfig?: {
    discoveryUrl: string;
    allowedAudience: string[];
    allowedClients: string[];
  };
}

export const GATEWAY_STEP_LABELS: Record<AddGatewayStep, string> = {
  name: 'Name',
  authorizer: 'Authorizer',
  'jwt-config': 'JWT Config',
  agents: 'Agents',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// MCP Tool Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type ExposureMode = 'mcp-runtime' | 'behind-gateway';

export type ComputeHost = 'Lambda' | 'AgentCoreRuntime';

/**
 * MCP tool wizard steps.
 * - name: Tool name input
 * - language: Target language (Python or TypeScript)
 * - exposure: MCP Runtime (standalone) or behind-gateway
 * - agents: Select agents to attach (only if mcp-runtime)
 * - gateway: Select existing gateway (only if behind-gateway)
 * - host: Select compute host (only if behind-gateway)
 * - confirm: Review and confirm
 */
export type AddMcpToolStep = 'name' | 'language' | 'exposure' | 'agents' | 'gateway' | 'host' | 'confirm';

export type TargetLanguage = 'Python' | 'TypeScript' | 'Other';

export interface AddMcpToolConfig {
  name: string;
  description: string;
  sourcePath: string;
  language: TargetLanguage;
  exposure: ExposureMode;
  /** Gateway name (only when exposure = behind-gateway) */
  gateway?: string;
  /** Compute host (AgentCoreRuntime for mcp-runtime, Lambda or AgentCoreRuntime for behind-gateway) */
  host: ComputeHost;
  /** Derived tool definition */
  toolDefinition: ToolDefinition;
  /** Agent names to attach (only when exposure = mcp-runtime) */
  selectedAgents: string[];
}

export const MCP_TOOL_STEP_LABELS: Record<AddMcpToolStep, string> = {
  name: 'Name',
  language: 'Language',
  exposure: 'Exposure',
  agents: 'Agents',
  gateway: 'Gateway',
  host: 'Host',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AUTHORIZER_TYPE_OPTIONS = [
  { id: 'NONE', title: 'None', description: 'No authorization required' },
  { id: 'CUSTOM_JWT', title: 'Custom JWT', description: 'JWT-based authorization via OIDC provider' },
] as const;

export const TARGET_LANGUAGE_OPTIONS = [
  { id: 'Python', title: 'Python', description: 'FastMCP Python server' },
  { id: 'TypeScript', title: 'TypeScript', description: 'MCP TypeScript server' },
  { id: 'Other', title: 'Other', description: 'Container-based implementation' },
] as const;

export const EXPOSURE_MODE_OPTIONS = [
  { id: 'mcp-runtime', title: 'MCP Runtime', description: 'Deploy as AgentCore MCP Runtime (select agents to attach)' },
  {
    id: 'behind-gateway',
    title: 'Behind Gateway (coming soon)',
    description: 'Route through AgentCore Gateway',
    disabled: true,
  },
] as const;

export const COMPUTE_HOST_OPTIONS = [
  { id: 'Lambda', title: 'Lambda', description: 'AWS Lambda function' },
  { id: 'AgentCoreRuntime', title: 'AgentCore Runtime', description: 'AgentCore Runtime (Python only)' },
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
