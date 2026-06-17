import type {
  BuildType,
  MemoryStrategyType,
  ModelProvider,
  ProtocolMode,
  SDKFramework,
  TargetLanguage,
} from '../../schema';

/**
 * Identity provider info for template rendering.
 */
export interface IdentityProviderRenderConfig {
  name: string;
  envVarName: string;
}

/**
 * Memory provider info for template rendering.
 */
export interface MemoryProviderRenderConfig {
  name: string;
  envVarName: string;
  /** Strategy types configured for this memory */
  strategies: MemoryStrategyType[];
}

/**
 * Gateway provider info for template rendering.
 */
export interface GatewayProviderRenderConfig {
  name: string;
  envVarName: string;
  authType: string; // AWS_IAM, CUSTOM_JWT, NONE
  /** Credential provider name for @requires_access_token (CUSTOM_JWT only) */
  credentialProviderName?: string;
  /** OIDC discovery URL for token endpoint lookup (CUSTOM_JWT only) */
  discoveryUrl?: string;
  /** Space-separated scopes for token request (CUSTOM_JWT only) */
  scopes?: string;
  /** Hardcoded URL for external gateways not found in deployed-state.json */
  hardcodedUrl?: string;
}

/**
 * Configuration needed by template renderers.
 * This is separate from the v2 Agent schema which only stores runtime config.
 */
export interface AgentRenderConfig {
  name: string;
  sdkFramework: SDKFramework;
  targetLanguage: TargetLanguage;
  modelProvider: ModelProvider;
  hasMemory: boolean;
  hasIdentity: boolean;
  hasGateway: boolean;
  hasPayment: boolean;
  /** Whether agent is deployed in VPC mode (affects example MCP endpoints) */
  isVpc: boolean;
  /** Build type: CodeZip (default) or Container */
  buildType?: BuildType;
  /** Memory providers for template rendering */
  memoryProviders: MemoryProviderRenderConfig[];
  /** Identity providers for template rendering (maps to credentials in schema) */
  identityProviders: IdentityProviderRenderConfig[];
  /** Gateway providers for template rendering */
  gatewayProviders: GatewayProviderRenderConfig[];
  /** Unique auth types across all gateways (for conditional imports) */
  gatewayAuthTypes: string[];
  /** Protocol (HTTP, MCP, A2A, AGUI). Defaults to HTTP. */
  protocol?: ProtocolMode;
  /** Custom Dockerfile name — when set, the template Dockerfile is not scaffolded */
  dockerfile?: string;
  /** Session storage mount path — when set, file read/write tools are included */
  sessionStorageMountPath?: string;
  /** EFS access point mounts — one set of read/write/list tools generated per mount */
  efsMounts?: { mountPath: string }[];
  /** S3 Files access point mounts — one set of read/write/list tools generated per mount */
  s3Mounts?: { mountPath: string }[];
  /** True when any filesystem mount is configured — drives `import os` in templates */
  needsOs?: boolean;
  /** Whether to wrap entrypoint with opentelemetry-instrument. Defaults to true. */
  enableOtel?: boolean;
  /** Whether a config bundle is wired into the agent template */
  hasConfigBundle?: boolean;

  // ── Export-only fields (set by harness-mapper, consumed by export templates) ──

  /** Execution limits from harness — triggers execution-limits capability */
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;

  /** Truncation strategy from harness. 'none' renders no truncation block (truncation disabled). */
  truncationStrategy?: 'sliding_window' | 'summarization' | 'none';
  truncationConfig?: Record<string, unknown>;

  /** Inline function tool definitions — one PythonAgentTool generated per entry */
  inlineFunctionTools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];

  /** Remote MCP tool definitions (non-gateway) */
  remoteMcpTools?: {
    name: string;
    url: string;
    headerCredentials?: { headerKey: string; credentialName: string; envVarName: string }[];
  }[];

  /** Skill paths for AgentSkills plugin */
  pathSkills?: string[];
  s3Skills?: string[];
  gitSkills?: { url: string; path?: string; credentialArn?: string; username?: string }[];
  /** True when any skills exist (path, s3, or git) — enables AgentSkills plugin */
  hasSkillsFetcher?: boolean;
  /** True when s3 or git skills exist — enables fetcher imports */
  hasFetchedSkills?: boolean;

  /** True when agentcore_browser tool is present and allowed */
  hasBrowser?: boolean;
  /** Custom browser identifier (resource ID extracted from browserArn) */
  browserIdentifier?: string;
  /** True when agentcore_code_interpreter tool is present and allowed */
  hasCodeInterpreter?: boolean;
  /** Custom code interpreter identifier (resource ID extracted from codeInterpreterArn) */
  codeInterpreterIdentifier?: string;
  /** True when the builtin shell tool is enabled (export harness only) */
  hasShell?: boolean;
  /** True when the builtin file_operations tool is enabled (export harness only) */
  hasFileOperations?: boolean;
  /** True when any execution limit is configured */
  hasExecutionLimits?: boolean;

  /** Model ID to use in load.py (export path only — overrides the provider-specific template default) */
  modelId?: string;

  /** True when generating from a harness export (suppresses placeholder tools) */
  isExportHarness?: boolean;
  /** System prompt text written verbatim into main.py (export path) */
  systemPromptText?: string;
  /** Default actor ID for memory session manager */
  actorId?: string;
}
