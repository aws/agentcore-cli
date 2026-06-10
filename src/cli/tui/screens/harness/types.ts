import type { HarnessApiFormat, HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import type { JwtConfig } from '../../components/jwt-config';

export type ContainerMode = 'none' | 'uri' | 'dockerfile';

export type AddHarnessStep =
  | 'name'
  | 'model-provider'
  | 'api-format'
  | 'api-key-arn'
  | 'container'
  | 'container-uri'
  | 'container-dockerfile'
  | 'advanced'
  | 'tools-select'
  | 'mcp-name'
  | 'mcp-url'
  | 'gateway-arn'
  | 'gateway-outbound-auth'
  | 'gateway-provider-arn'
  | 'gateway-scopes'
  | 'memory'
  | 'authorizerType'
  | 'jwtConfig'
  | 'network-mode'
  | 'subnets'
  | 'security-groups'
  | 'idle-timeout'
  | 'max-lifetime'
  | 'max-iterations'
  | 'max-tokens'
  | 'timeout'
  | 'truncation-strategy'
  | 'session-storage-path'
  | 'efs-arn'
  | 'efs-mount-path'
  | 'efs-add-another'
  | 's3-arn'
  | 's3-mount-path'
  | 's3-add-another'
  | 'confirm';

export interface AddHarnessConfig {
  name: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiFormat?: HarnessApiFormat;
  apiKeyArn?: string;
  skipMemory?: boolean;
  containerMode?: ContainerMode;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  truncationStrategy?: 'sliding_window' | 'summarization';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  idleTimeout?: number;
  maxLifetime?: number;
  sessionStoragePath?: string;
  efsAccessPoints?: { accessPointArn: string; mountPath: string }[];
  s3AccessPoints?: { accessPointArn: string; mountPath: string }[];
  authorizerType?: RuntimeAuthorizerType;
  jwtConfig?: JwtConfig;
  selectedTools?: string[];
  mcpName?: string;
  mcpUrl?: string;
  gatewayArn?: string;
  gatewayOutboundAuth?: 'awsIam' | 'none' | 'oauth';
  gatewayProviderArn?: string;
  gatewayScopes?: string;
}

export const HARNESS_STEP_LABELS: Record<AddHarnessStep, string> = {
  name: 'Name',
  'model-provider': 'Model provider',
  'api-format': 'API format',
  'api-key-arn': 'API key ARN',
  container: 'Custom environment',
  'container-uri': 'Container URI',
  'container-dockerfile': 'Dockerfile path',
  advanced: 'Advanced settings',
  'tools-select': 'Tools',
  'mcp-name': 'MCP name',
  'mcp-url': 'MCP URL',
  'gateway-arn': 'Gateway ARN',
  'gateway-outbound-auth': 'Gateway auth',
  'gateway-provider-arn': 'Provider ARN',
  'gateway-scopes': 'OAuth scopes',
  memory: 'Memory',
  authorizerType: 'Auth type',
  jwtConfig: 'JWT config',
  'network-mode': 'Network mode',
  subnets: 'Subnets',
  'security-groups': 'Security groups',
  'idle-timeout': 'Idle timeout',
  'max-lifetime': 'Max lifetime',
  'max-iterations': 'Max iterations',
  'max-tokens': 'Max tokens',
  timeout: 'Timeout',
  'truncation-strategy': 'Truncation',
  'session-storage-path': 'Session storage path',
  'efs-arn': 'EFS ARN',
  'efs-mount-path': 'EFS Path',
  'efs-add-another': 'Add EFS',
  's3-arn': 'S3 Files ARN',
  's3-mount-path': 'S3 Files Path',
  's3-add-another': 'Add S3 Files',
  confirm: 'Confirm',
};

export const DEFAULT_MODEL_IDS: Record<HarnessModelProvider, string> = {
  bedrock: 'global.anthropic.claude-sonnet-4-6',
  open_ai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
};

export const DEFAULT_BEDROCK_MANTLE_MODEL_ID = 'openai.gpt-oss-120b';

export const MODEL_PROVIDER_OPTIONS = [
  { id: 'bedrock' as const, title: 'Amazon Bedrock', description: `Default: ${DEFAULT_MODEL_IDS.bedrock}` },
  {
    id: 'open_ai' as const,
    title: 'OpenAI',
    description: `Default: ${DEFAULT_MODEL_IDS.open_ai} (requires API key ARN)`,
  },
  {
    id: 'gemini' as const,
    title: 'Google Gemini',
    description: `Default: ${DEFAULT_MODEL_IDS.gemini} (requires API key ARN)`,
  },
] as const;

export const BEDROCK_API_FORMAT_OPTIONS = [
  {
    id: 'converse_stream' as const,
    title: 'Converse Stream',
    description: 'Standard Bedrock Converse API (default)',
  },
  {
    id: 'responses' as const,
    title: 'Responses',
    description: 'OpenAI Responses API via Bedrock Mantle',
  },
  {
    id: 'chat_completions' as const,
    title: 'Chat Completions',
    description: 'OpenAI Chat Completions API via Bedrock Mantle',
  },
] as const;

export const OPENAI_API_FORMAT_OPTIONS = [
  {
    id: 'responses' as const,
    title: 'Responses',
    description: 'OpenAI Responses API (default)',
  },
  {
    id: 'chat_completions' as const,
    title: 'Chat Completions',
    description: 'OpenAI Chat Completions API',
  },
] as const;

export const API_FORMAT_OPTIONS = BEDROCK_API_FORMAT_OPTIONS;

export const TRUNCATION_STRATEGY_OPTIONS = [
  { id: 'sliding_window' as const, title: 'Sliding window', description: 'Keep most recent messages' },
  { id: 'summarization' as const, title: 'Summarization', description: 'Compress older context' },
] as const;

export const ADVANCED_SETTING_OPTIONS = [
  { id: 'tools', title: 'Tools', description: 'Add browser, code interpreter, MCP, or gateway tools' },
  { id: 'auth', title: 'Authentication', description: 'Inbound auth: AWS_IAM or Custom JWT' },
  { id: 'network', title: 'Network', description: 'Deploy inside a VPC with custom subnets and security groups' },
  { id: 'lifecycle', title: 'Lifecycle', description: 'Set idle timeout and max session lifetime' },
  { id: 'execution', title: 'Execution limits', description: 'Cap iterations, tokens, and per-turn timeout' },
  { id: 'truncation', title: 'Truncation', description: 'Choose how context is managed when it exceeds limits' },
  {
    id: 'session-storage',
    title: 'Filesystem Storage',
    description: 'Mount session storage, EFS, or S3 Files persistent storage (requires VPC)',
  },
] as const;

export type AdvancedSetting = (typeof ADVANCED_SETTING_OPTIONS)[number]['id'];

export const MEMORY_OPTIONS = [
  {
    id: 'disabled' as const,
    title: 'No persistent memory',
    description: 'Harness does not retain context across sessions',
  },
  { id: 'enabled' as const, title: 'Enabled', description: 'Create persistent memory for this harness' },
] as const;

export const CONTAINER_MODE_OPTIONS = [
  { id: 'none' as const, title: 'Default Environment', description: 'Includes Python, Bash, File tools' },
  { id: 'uri' as const, title: 'Container URI', description: 'Use a pre-built container image (ECR URI)' },
  { id: 'dockerfile' as const, title: 'Dockerfile', description: 'Bring your own Dockerfile' },
] as const;

export const TOOL_SELECT_OPTIONS = [
  { id: 'agentcore_browser' as const, title: 'AgentCore Browser', description: 'Web browsing and automation' },
  {
    id: 'agentcore_code_interpreter' as const,
    title: 'AgentCore Code Interpreter',
    description: 'Sandboxed code execution',
  },
  { id: 'agentcore_gateway' as const, title: 'AgentCore Gateway', description: 'Connect via gateway' },
  { id: 'remote_mcp' as const, title: 'Remote MCP Server', description: 'Connect to an MCP server' },
] as const;

export const NETWORK_MODE_OPTIONS = [
  { id: 'PUBLIC' as const, title: 'Public', description: 'Internet-facing' },
  { id: 'VPC' as const, title: 'VPC', description: 'Deploy within a VPC' },
] as const;

export const AUTHORIZER_TYPE_OPTIONS = [
  { id: 'AWS_IAM' as const, title: 'AWS IAM', description: 'Use AWS IAM authentication (default)' },
  { id: 'CUSTOM_JWT' as const, title: 'Custom JWT', description: 'Use a custom JWT authorizer (OIDC)' },
] as const;

export const GATEWAY_OUTBOUND_AUTH_OPTIONS = [
  { id: 'awsIam', title: 'AWS IAM (default)', description: 'SigV4 signing with the harness execution role' },
  { id: 'none', title: 'None', description: 'No authentication headers' },
  { id: 'oauth', title: 'OAuth', description: 'Bearer token via AgentCore Identity credential provider' },
];
