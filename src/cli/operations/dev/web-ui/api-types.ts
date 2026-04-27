/**
 * Shared API contract types for the Web UI proxy server.
 *
 * These types define the request/response shapes for all HTTP endpoints
 * served by WebUIServer. The frontend repo maintains its own copy of
 * these types — keep both in sync when changing endpoint shapes.
 *
 * TODO: Extract these types into a shared package so both repos import
 * from a single source of truth instead of manually duplicating.
 */

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

/** Response shape for GET /api/status */
export interface StatusResponse {
  agents: StatusAgent[];
  running: StatusRunningAgent[];
  errors: StatusAgentError[];
  /** Agent name to pre-select in the UI (set when --runtime is specified) */
  selectedAgent?: string;
}

/** Agent metadata returned in the status response */
export interface StatusAgent {
  name: string;
  buildType: string;
  protocol: string;
}

/** Running agent entry in the status response */
export interface StatusRunningAgent {
  name: string;
  /** Port the agent is listening on. */
  port: number;
}

/** Per-agent error state in the status response */
export interface StatusAgentError {
  name: string;
  message: string;
}

// ---------------------------------------------------------------------------
// GET /api/resources
// ---------------------------------------------------------------------------

/** Deployment state for a resource: matches the status command's ResourceDeploymentState */
export type ResourceDeploymentStatus = 'deployed' | 'local-only' | 'pending-removal';

/** Deployed state for an agent runtime */
export interface DeployedAgentState {
  runtimeId: string;
  runtimeArn: string;
  roleArn: string;
}

/** Deployed state for a memory */
export interface DeployedMemoryState {
  memoryId: string;
  memoryArn: string;
}

/** Deployed state for a credential */
export interface DeployedCredentialState {
  credentialProviderArn: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}

/** Deployed state for a gateway */
export interface DeployedGatewayState {
  gatewayId: string;
  gatewayArn: string;
  gatewayUrl?: string;
}

/** Deployed state for an evaluator */
export interface DeployedEvaluatorState {
  evaluatorId: string;
  evaluatorArn: string;
}

/** Deployed state for an online eval config */
export interface DeployedOnlineEvalState {
  onlineEvaluationConfigId: string;
  onlineEvaluationConfigArn: string;
  executionStatus?: 'ENABLED' | 'DISABLED';
}

/** Deployed state for a policy engine */
export interface DeployedPolicyEngineState {
  policyEngineId: string;
  policyEngineArn: string;
}

/** Deployed state for a policy */
export interface DeployedPolicyState {
  policyId: string;
  policyArn: string;
  engineName: string;
}

/** Successful response shape for GET /api/resources */
export interface ResourcesResponse {
  success: true;
  project: string;
  agents: ResourceAgent[];
  memories: ResourceMemory[];
  credentials: ResourceCredential[];
  gateways: ResourceGateway[];
  mcpRuntimeTools: ResourceMcpTool[];
  evaluators: ResourceEvaluator[];
  onlineEvalConfigs: ResourceOnlineEvalConfig[];
  policyEngines: ResourcePolicyEngine[];
  unassignedTargets: ResourceUnassignedTarget[];
}

/** Agent details in the resources response */
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

/** Memory details in the resources response */
export interface ResourceMemory {
  name: string;
  strategies: ResourceMemoryStrategy[];
  expiryDays: number | undefined;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedMemoryState;
}

/** Memory strategy with namespace patterns */
export interface ResourceMemoryStrategy {
  type: string;
  /** Namespace patterns, e.g. "/users/{actorId}/facts", "/summaries/{actorId}/{sessionId}" */
  namespaces: string[];
}

/** Credential details in the resources response */
export interface ResourceCredential {
  name: string;
  type: string;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedCredentialState;
}

/** Gateway details in the resources response */
export interface ResourceGateway {
  name: string;
  targets: ResourceGatewayTarget[];
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedGatewayState;
}

/** Gateway target details */
export interface ResourceGatewayTarget {
  name: string;
  targetType: string;
}

/** MCP runtime tool details in the resources response */
export interface ResourceMcpTool {
  name: string;
  bindings: ResourceMcpToolBinding[];
  deploymentStatus?: ResourceDeploymentStatus;
}

/** MCP tool binding to a runtime */
export interface ResourceMcpToolBinding {
  runtimeName: string;
  envVarName: string;
}

/** Evaluator details in the resources response */
export interface ResourceEvaluator {
  name: string;
  level: string;
  description?: string;
  configType: 'llm-as-a-judge' | 'code-based';
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedEvaluatorState;
}

/** Online eval config details in the resources response */
export interface ResourceOnlineEvalConfig {
  name: string;
  agent: string;
  evaluators: string[];
  samplingRate: number;
  description?: string;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedOnlineEvalState;
}

/** Policy engine details in the resources response */
export interface ResourcePolicyEngine {
  name: string;
  description?: string;
  policies: ResourcePolicy[];
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedPolicyEngineState;
}

/** Policy details in the resources response */
export interface ResourcePolicy {
  name: string;
  description?: string;
  deploymentStatus?: ResourceDeploymentStatus;
  deployed?: DeployedPolicyState;
}

/** Unassigned gateway target details in the resources response */
export interface ResourceUnassignedTarget {
  name: string;
  targetType: string;
}

// ---------------------------------------------------------------------------
// POST /api/start
// ---------------------------------------------------------------------------

/** Request body for POST /api/start */
export interface StartRequest {
  agentName: string;
}

/** Response shape for POST /api/start */
export interface StartResponse {
  success: boolean;
  name: string;
  port: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /invocations
// ---------------------------------------------------------------------------

/** Request body for POST /invocations */
export interface InvocationRequest {
  agentName?: string;
  prompt?: string;
  sessionId?: string;
  userId?: string;
}

// ---------------------------------------------------------------------------
// GET /api/traces?agentName=xxx
// ---------------------------------------------------------------------------

/** Response shape for GET /api/traces */
export interface ListTracesResponse {
  success: boolean;
  traces?: unknown[];
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/traces/:traceId?agentName=xxx
// ---------------------------------------------------------------------------

/** Response shape for GET /api/traces/:traceId */
export interface GetTraceResponse {
  success: boolean;
  resourceSpans?: unknown[];
  resourceLogs?: unknown[];
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/memory?memoryName=xxx&namespace=yyy[&strategyId=zzz]
// ---------------------------------------------------------------------------

/** Response shape for GET /api/memory */
export interface ListMemoryRecordsResponse {
  success: boolean;
  records?: MemoryRecordResponse[];
  nextToken?: string;
  error?: string;
}

/** A single memory record in list/search responses */
export interface MemoryRecordResponse {
  memoryRecordId: string;
  content: string | undefined;
  memoryStrategyId: string;
  namespaces: string[];
  createdAt: string;
  score: number | undefined;
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// POST /api/memory/search
// ---------------------------------------------------------------------------

/** Request body for POST /api/memory/search */
export interface RetrieveMemoryRecordsRequest {
  memoryName: string;
  namespace: string;
  searchQuery: string;
  strategyId?: string;
}

/** Response shape for POST /api/memory/search */
export interface RetrieveMemoryRecordsResponse {
  success: boolean;
  records?: MemoryRecordResponse[];
  nextToken?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Common error response (used by all endpoints on failure)
// ---------------------------------------------------------------------------

/** Error response shape returned by any endpoint on failure */
export interface ApiErrorResponse {
  success: false;
  error: string;
}

// ---------------------------------------------------------------------------
// POST /api/mcp — Thin proxy that forwards JSON-RPC to an agent's MCP endpoint
// ---------------------------------------------------------------------------

/** Request body for POST /api/mcp */
export interface McpProxyRequest {
  agentName: string;
  body: Record<string, unknown>;
}

/** Response shape for POST /api/mcp */
export interface McpProxyResponse {
  success: true;
  result: unknown;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// GET /api/a2a/agent-card?agentName=xxx — Fetch A2A agent card
// ---------------------------------------------------------------------------

/** A2A agent skill metadata */
export interface A2AAgentSkill {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/** A2A agent card returned by /.well-known/agent.json */
export interface A2AAgentCard {
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  skills?: A2AAgentSkill[];
  capabilities?: { streaming?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** Response shape for GET /api/a2a/agent-card */
export interface A2AAgentCardResponse {
  success: true;
  card: A2AAgentCard;
}
