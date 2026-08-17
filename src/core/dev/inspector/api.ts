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
// POST /api/mcp
// ---------------------------------------------------------------------------

export interface McpProxyRequest {
  agentName?: string;
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
// GET /api/resources
// ---------------------------------------------------------------------------

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
}

export interface ResourceHarness {
  name: string;
  /** @deprecated The reference derived this from the harness spec's model. */
  model: string;
  tools: string[];
}

export interface ResourceMemory {
  name: string;
  strategies: ResourceMemoryStrategy[];
  expiryDays: number | undefined;
}

export interface ResourceMemoryStrategy {
  type: string;
  /** Namespace templates, e.g. "/users/{actorId}/facts". */
  namespaceTemplates: string[];
}

export interface ResourceCredential {
  name: string;
  type: string;
}

export interface ResourceGateway {
  name: string;
  targets: ResourceGatewayTarget[];
}

export interface ResourceGatewayTarget {
  name: string;
  targetType: string;
}

export interface ResourceMcpTool {
  name: string;
  bindings: ResourceMcpToolBinding[];
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
}

export interface ResourcePolicyEngine {
  name: string;
  description?: string;
  policies: ResourcePolicy[];
}

export interface ResourcePolicy {
  name: string;
  description?: string;
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
