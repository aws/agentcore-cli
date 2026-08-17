/**
 * Wire types for the Agent Inspector HTTP API, ported from the original CLI's
 * web-ui/api-types.ts. The prebuilt Inspector SPA depends on these exact field
 * names — keep every shape byte-compatible with the reference when changing
 * anything here.
 */

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  mode: "dev";
  agents: StatusAgent[];
  harnesses: StatusHarness[];
  running: StatusRunningAgent[];
  errors: StatusAgentError[];
  /** Agent name to pre-select in the UI (set when --runtime is specified). */
  selectedAgent?: string;
}

export interface StatusAgent {
  name: string;
  buildType: string;
  protocol: string;
}

export interface StatusRunningAgent {
  name: string;
  /** Port the agent is listening on. */
  port: number;
}

export interface StatusAgentError {
  name: string;
  message: string;
}

export interface StatusHarness {
  name: string;
}

// ---------------------------------------------------------------------------
// POST /api/start
// ---------------------------------------------------------------------------

export interface StartRequest {
  agentName: string;
}

export interface StartResponse {
  success: boolean;
  name: string;
  port: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /invocations
// ---------------------------------------------------------------------------

export interface InvocationRequest {
  agentName?: string;
  targetName?: string;
  prompt?: string;
  sessionId?: string;
  userId?: string;
}

// ---------------------------------------------------------------------------
// GET /api/traces[/:traceId]?agentName=xxx
// ---------------------------------------------------------------------------

export interface ListTracesResponse {
  success: boolean;
  traces?: unknown[];
  error?: string;
}

export interface GetTraceResponse {
  success: boolean;
  resourceSpans?: unknown[];
  resourceLogs?: unknown[];
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/cloudwatch-traces[/:traceId]?agentName=xxx|harnessName=xxx
// ---------------------------------------------------------------------------

export interface CloudWatchTraceEntry {
  traceId: string;
  timestamp: string;
  sessionId?: string;
  spanCount?: string;
}

export interface ListCloudWatchTracesResponse {
  success: boolean;
  traces?: CloudWatchTraceEntry[];
  error?: string;
}

export interface GetCloudWatchTraceResponse {
  success: boolean;
  records?: unknown[];
  spans?: unknown[];
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/memory + POST /api/memory/search
// ---------------------------------------------------------------------------

/**
 * Namespace selector shared by memory list and search. Exactly one of
 * `namespace` (exact match) or `namespacePath` (hierarchical path prefix)
 * must be provided.
 */
export type MemoryNamespaceSelector =
  { namespace: string; namespacePath?: never } | { namespace?: never; namespacePath: string };

export type ListMemoryRecordsQuery = {
  memoryName: string;
  strategyId?: string;
} & MemoryNamespaceSelector;

export type RetrieveMemoryRecordsRequest = {
  memoryName: string;
  searchQuery: string;
  strategyId?: string;
} & MemoryNamespaceSelector;

export interface MemoryRecordResponse {
  memoryRecordId: string;
  content: string | undefined;
  memoryStrategyId: string;
  namespaces: string[];
  createdAt: string;
  score: number | undefined;
  metadata: Record<string, string>;
}

export interface MemoryRecordsResponse {
  success: boolean;
  records?: MemoryRecordResponse[];
  nextToken?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /api/mcp
// ---------------------------------------------------------------------------

export interface McpProxyRequest {
  agentName?: string;
  targetName?: string;
  body?: Record<string, unknown>;
  sessionId?: string;
}

export interface McpProxyResponse {
  success: true;
  result: unknown;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// GET /api/a2a/agent-card?agentName=xxx
// ---------------------------------------------------------------------------

export interface A2AAgentCardResponse {
  success: true;
  card: unknown;
}

// ---------------------------------------------------------------------------
// Harness invocation (POST /invocations with harnessName) +
// POST /api/harness/tool-response
// ---------------------------------------------------------------------------

/**
 * Overrides forwarded verbatim to the harness invocation. The reference typed
 * `model`, `skills`, and `tools` with AWS SDK shapes; the inspector only passes
 * them through, so they stay opaque here.
 */
export interface HarnessInvocationOverrides {
  model?: unknown;
  systemPrompt?: string;
  skills?: unknown[];
  actorId?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  allowedTools?: string[];
  tools?: unknown[];
}

export interface HarnessMessage {
  role: string;
  content: Record<string, unknown>[];
}

export interface HarnessToolResponseRequest {
  harnessName: string;
  sessionId: string;
  messages: HarnessMessage[];
  harnessOverrides?: HarnessInvocationOverrides;
}

// ---------------------------------------------------------------------------
// GET /api/resources
// ---------------------------------------------------------------------------

export type ResourceDeploymentStatus = "deployed" | "local-only" | "pending-removal";

export interface DeployedAgentState {
  runtimeId: string;
  runtimeArn: string;
  roleArn: string;
}

export interface DeployedMemoryState {
  memoryId: string;
  memoryArn: string;
}

export interface DeployedCredentialState {
  credentialProviderArn: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}

export interface DeployedGatewayState {
  gatewayId: string;
  gatewayArn: string;
  gatewayUrl?: string;
}

export interface DeployedHarnessState {
  harnessId: string;
  harnessArn: string;
}

export interface ResourcesResponse {
  success: true;
  project: string;
  agents: ResourceAgent[];
  harnesses: ResourceHarness[];
  memories: ResourceMemory[];
  credentials: ResourceCredential[];
  gateways: ResourceGateway[];
  mcpRuntimeTools: ResourceMcpTool[];
  evaluators: ResourceEvaluator[];
  onlineEvalConfigs: ResourceOnlineEvalConfig[];
  policyEngines: ResourcePolicyEngine[];
  unassignedTargets: ResourceUnassignedTarget[];
  deploymentTargets: ResourceDeploymentTarget[];
}

export interface ResourceDeploymentTarget {
  name: string;
  region: string;
  description?: string;
}

export interface ResourceAgent {
  name: string;
  build: string;
  entrypoint: string;
  codeLocation: string;
  runtimeVersion: string;
  networkMode: string;
  protocol: string;
  envVars: string[];
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedAgentState;
  invocationUrl?: string;
}

export interface ResourceHarness {
  name: string;
  /** @deprecated The reference derived this from the harness spec's model. */
  model: string;
  tools: string[];
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedHarnessState;
}

export interface ResourceMemory {
  name: string;
  strategies: ResourceMemoryStrategy[];
  expiryDays: number | undefined;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedMemoryState;
}

export interface ResourceMemoryStrategy {
  type: string;
  /** Namespace templates, e.g. "/users/{actorId}/facts". */
  namespaceTemplates: string[];
}

export interface ResourceCredential {
  name: string;
  type: string;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedCredentialState;
}

export interface ResourceGateway {
  name: string;
  targets: ResourceGatewayTarget[];
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedGatewayState;
}

export interface ResourceGatewayTarget {
  name: string;
  targetType: string;
}

export interface ResourceMcpTool {
  name: string;
  bindings: ResourceMcpToolBinding[];
  deploymentStatus?: ResourceDeploymentStatus;
}

export interface ResourceMcpToolBinding {
  runtimeName: string;
  envVarName: string;
}

export interface ResourceEvaluator {
  name: string;
  level: string;
  description?: string;
  configType: "llm-as-a-judge" | "code-based";
  deploymentStatus?: ResourceDeploymentStatus;
}

export interface ResourceOnlineEvalConfig {
  name: string;
  agent?: string;
  evaluators?: string[];
  insights?: string[];
  samplingRate: number;
  description?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
  deploymentStatus?: ResourceDeploymentStatus;
}

export interface ResourcePolicyEngine {
  name: string;
  description?: string;
  policies: ResourcePolicy[];
  deploymentStatus?: ResourceDeploymentStatus;
}

export interface ResourcePolicy {
  name: string;
  description?: string;
  deploymentStatus?: ResourceDeploymentStatus;
}

export interface ResourceUnassignedTarget {
  name: string;
  targetType: string;
}

// ---------------------------------------------------------------------------
// Common error response (used by all endpoints on failure)
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  success: false;
  error: string;
}
