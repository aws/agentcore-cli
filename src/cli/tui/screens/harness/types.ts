import type { HarnessApiFormat, HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import type { JwtConfig } from '../../components/jwt-config';

export type ContainerMode = 'none' | 'uri' | 'dockerfile';

export type AddHarnessStep =
  | 'name'
  | 'model-provider'
  | 'api-format'
  | 'api-key-arn'
  | 'api-base'
  | 'additional-params'
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
  | 'skills-source-type'
  | 'skill-path'
  | 'skill-s3-uri'
  | 'skill-git-url'
  | 'skill-git-path'
  | 'skill-git-credential'
  | 'skill-git-username'
  | 'skill-aws-skills-paths'
  | 'skill-add-another'
  | 'memory-mode'
  | 'memory-strategies'
  | 'memory-event-expiry'
  | 'memory-kms'
  | 'memory-existing-ref'
  | 'authorizerType'
  | 'jwtConfig'
  | 'network-mode'
  | 'subnets'
  | 'security-groups'
  | 'vpc-id'
  | 'idle-timeout'
  | 'max-lifetime'
  | 'max-iterations'
  | 'max-tokens'
  | 'timeout'
  | 'temperature'
  | 'top-p'
  | 'top-k'
  | 'model-max-tokens'
  | 'memory-messages-count'
  | 'memory-retrieval-top-k'
  | 'memory-relevance-score'
  | 'mcp-headers'
  | 'allowed-tools'
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
  apiBase?: string;
  additionalParams?: Record<string, unknown>;
  containerMode?: ContainerMode;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  modelMaxTokens?: number;
  /**
   * Mode-tagged memory ref. Mirrors the schema union.
   * `managed` owns memory internally; `existing` references a memory by name/arn; `disabled` opts out.
   */
  memory?:
    | { mode: 'managed'; strategies?: string[]; eventExpiryDuration?: number; encryptionKeyArn?: string }
    | {
        mode: 'existing';
        name?: string;
        arn?: string;
        actorId?: string;
        messagesCount?: number;
        topK?: number;
        relevanceScore?: number;
      }
    | { mode: 'disabled' };
  mcpHeaders?: Record<string, string>;
  allowedTools?: string[];
  truncationStrategy?: 'sliding_window' | 'summarization' | 'none';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  /** VPC ID for dockerfile (container) builds in VPC mode (CodeBuild cannot infer it from subnets) */
  vpcId?: string;
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
  skills?: {
    path?: string;
    s3Uri?: string;
    gitUrl?: string;
    gitPath?: string;
    credentialName?: string;
    username?: string;
    awsSkills?: string[];
  }[];
  pendingSkillSourceType?: 'path' | 's3' | 'git' | 'aws_skills';
  pendingSkillGitUrl?: string;
  pendingSkillGitPath?: string;
  pendingSkillCredentialName?: string;
}

export const HARNESS_STEP_LABELS: Record<AddHarnessStep, string> = {
  name: 'Name',
  'model-provider': 'Model provider',
  'api-format': 'API format',
  'api-key-arn': 'API key ARN',
  'api-base': 'API base URL',
  'additional-params': 'Additional params',
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
  'skills-source-type': 'Skill source',
  'skill-path': 'Skill path',
  'skill-s3-uri': 'S3 URI',
  'skill-git-url': 'Git URL',
  'skill-git-path': 'Git sub-path',
  'skill-git-credential': 'Git credential',
  'skill-git-username': 'Username',
  'skill-aws-skills-paths': 'AWS Skills paths',
  'skill-add-another': 'Add skill',
  'memory-mode': 'Memory mode',
  'memory-strategies': 'Memory strategies',
  'memory-event-expiry': 'Memory event expiry (days)',
  'memory-kms': 'Memory KMS key ARN',
  'memory-existing-ref': 'Existing memory reference',
  authorizerType: 'Auth type',
  jwtConfig: 'JWT config',
  'network-mode': 'Network mode',
  subnets: 'Subnets',
  'security-groups': 'Security groups',
  'vpc-id': 'VPC ID',
  'idle-timeout': 'Idle timeout',
  'max-lifetime': 'Max lifetime',
  'max-iterations': 'Max iterations',
  'max-tokens': 'Max tokens',
  timeout: 'Timeout',
  temperature: 'Temperature',
  'top-p': 'Top P',
  'top-k': 'Top K',
  'model-max-tokens': 'Model max tokens',
  'memory-messages-count': 'Memory messages count',
  'memory-retrieval-top-k': 'Memory retrieval top K',
  'memory-relevance-score': 'Memory relevance score',
  'mcp-headers': 'MCP headers',
  'allowed-tools': 'Allowed tools',
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
  lite_llm: 'anthropic/claude-sonnet-4-5',
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
  {
    id: 'lite_llm' as const,
    title: 'LiteLLM',
    description: `Default: ${DEFAULT_MODEL_IDS.lite_llm} (API key ARN optional)`,
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
  { id: 'none' as const, title: 'None', description: 'Disable truncation' },
] as const;

export const ADVANCED_SETTING_OPTIONS = [
  { id: 'tools', title: 'Tools', description: 'Add browser, code interpreter, MCP, or gateway tools' },
  { id: 'skills', title: 'Skills', description: 'Add agent skills' },
  // Two mode-scoped memory-tuning options: only the one matching the chosen memory mode is shown in
  // the advanced list (see AddHarnessScreen's filter). Managed and existing have disjoint knob sets
  // per the harness API, so they never both appear.
  {
    id: 'memory-managed-tuning',
    title: 'Memory tuning',
    description: 'Managed memory: strategies, event retention, encryption key',
  },
  {
    id: 'memory-existing-tuning',
    title: 'Memory tuning',
    description: 'Existing memory: actor ID, messages count, retrieval (topK, relevance)',
  },
  { id: 'allowed-tools', title: 'Allowed tools', description: 'Restrict which tools the agent may invoke' },
  { id: 'auth', title: 'Authentication', description: 'Inbound auth: AWS_IAM or Custom JWT' },
  { id: 'network', title: 'Network', description: 'Deploy inside a VPC with custom subnets and security groups' },
  { id: 'lifecycle', title: 'Lifecycle', description: 'Set idle timeout and max session lifetime' },
  {
    id: 'execution',
    title: 'Execution & sampling',
    description: 'Cap iterations, tokens, timeout; tune temperature, topP, topK',
  },
  { id: 'truncation', title: 'Truncation', description: 'Choose how context is managed when it exceeds limits' },
  {
    id: 'session-storage',
    title: 'Filesystem Storage',
    description: 'Mount session storage, EFS, or S3 Files persistent storage (requires VPC)',
  },
] as const;

export type AdvancedSetting = (typeof ADVANCED_SETTING_OPTIONS)[number]['id'];

/** Mode-first memory options. Mirrors the schema's 3-mode union. */
export const MEMORY_MODE_OPTIONS = [
  // "No memory" is first so it is the highlighted default (the picker selects index 0). Memory is
  // opt-in: a harness has no memory unless the user picks Managed or Existing here. The id stays
  // 'disabled' — it is the schema/CFN contract token; only the displayed title is reworded.
  { id: 'disabled' as const, title: 'No memory', description: 'Default' },
  {
    id: 'managed' as const,
    title: 'Managed',
    description: 'AgentCore creates and manages memory for this harness',
  },
  { id: 'existing' as const, title: 'Existing', description: 'Reference an existing memory by name or ARN' },
] as const;

/** Managed-memory strategy choices (the four CFN ManagedMemoryConfiguration.Strategies values). */
export const MANAGED_STRATEGY_OPTIONS = [
  { id: 'SEMANTIC' as const, title: 'Semantic', description: 'Extract and retrieve semantic facts' },
  { id: 'SUMMARIZATION' as const, title: 'Summarization', description: 'Summarize conversation history' },
  { id: 'USER_PREFERENCE' as const, title: 'User preference', description: 'Track user preferences' },
  { id: 'EPISODIC' as const, title: 'Episodic', description: 'Recall past episodes/sessions' },
] as const;

/** Keep/customize options for the managed retention + encryption tuning sub-flow. */

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

export const SKILL_SOURCE_TYPE_OPTIONS = [
  { id: 'path' as const, title: 'Path', description: 'Path to an installed skill in the environment' },
  { id: 's3' as const, title: 'S3', description: 'S3 URI (s3://bucket/path)' },
  { id: 'git' as const, title: 'Git', description: 'HTTPS git repository URL' },
  {
    id: 'aws_skills' as const,
    title: 'AWS Skills',
    description: 'Built-in AWS skills (github.com/aws/agent-toolkit-for-aws/tree/main/skills)',
  },
] as const;
