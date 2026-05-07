/**
 * AWS client wrappers for Recommendation API operations.
 *
 * NOTE: The Recommendation API is not yet available in the AWS SDK.
 * These wrappers use direct HTTP requests with SigV4 signing as an
 * interim solution. When the SDK adds Recommendation commands, migrate
 * to the SDK client.
 *
 * TEMPORARY: All Recommendation endpoints are on the Data Plane (DP),
 * not the Control Plane. This is the current API shape as of 2026-03-30.
 * The API may move to CP in the future — update endpoints accordingly.
 *
 * Recommendations are one-shot, immutable resources. There is no Update
 * operation and no runs sub-resource. You start a recommendation with
 * StartRecommendation, poll via GetRecommendation, and stop via
 * DeleteRecommendation (stop-via-delete pattern).
 */
import { getCredentialProvider } from './account';
import { dnsSuffix } from './partition';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

// ============================================================================
// Types — Recommendation Type Enum
// ============================================================================

export type RecommendationType = 'SYSTEM_PROMPT_RECOMMENDATION' | 'TOOL_DESCRIPTION_RECOMMENDATION';

// ============================================================================
// Types — Input Config (tag-union per type)
// ============================================================================

/** System prompt source — either inline text or a ConfigBundle reference. */
export interface SystemPromptSource {
  text?: string;
  configurationBundle?: {
    bundleArn: string;
    versionId?: string;
    systemPromptJsonPath?: string;
  };
}

/** A single OTEL-style span for inline session traces. */
export interface SessionSpan {
  scope?: { name: string };
  body?: {
    input?: { messages?: { content: unknown; role: string }[] };
    output?: { messages?: { content: unknown; role: string }[] };
  };
  attributes?: Record<string, unknown>;
  traceId: string;
  spanId: string;
}

/** Agent trace source — inline spans or CloudWatch Logs. */
export interface AgentTracesSource {
  sessionSpans?: SessionSpan[];
  cloudwatchLogs?: {
    logGroupArns: string[];
    serviceNames: string[];
    startTime: string;
    endTime: string;
    limit?: number;
    sessionIds?: string[];
  };
}

/** Evaluation config — exactly one evaluator as objective signal (API constraint: min 1, max 1). */
export interface RecommendationEvaluationConfig {
  evaluators: [{ evaluatorArn: string }];
}

/** Config for SYSTEM_PROMPT_RECOMMENDATION type. */
export interface SystemPromptRecommendationConfig {
  systemPrompt: SystemPromptSource;
  agentTraces: AgentTracesSource;
  evaluationConfig: RecommendationEvaluationConfig;
}

/** Config for TOOL_DESCRIPTION_RECOMMENDATION type. */
export interface ToolDescriptionRecommendationConfig {
  toolDescription: {
    toolDescriptionText?: {
      tools: { toolName: string; toolDescription: { text: string } }[];
    };
    configurationBundle?: {
      bundleArn: string;
      versionId?: string;
      tools: { toolName: string; toolDescriptionJsonPath: string }[];
    };
  };
  agentTraces: AgentTracesSource;
}

/** Tag-union recommendation config — only populate the member matching the type. */
export interface RecommendationConfig {
  systemPromptRecommendationConfig?: SystemPromptRecommendationConfig;
  toolDescriptionRecommendationConfig?: ToolDescriptionRecommendationConfig;
}

// ============================================================================
// Types — Result (tag-union per type)
// ============================================================================

export interface RecommendationResultConfigurationBundle {
  bundleArn: string;
  versionId: string;
}

export interface SystemPromptRecommendationResult {
  recommendedSystemPrompt?: string;
  configurationBundle?: RecommendationResultConfigurationBundle;
  errorCode?: string;
  errorMessage?: string;
}

export interface ToolDescriptionRecommendationToolResult {
  toolName: string;
  recommendedToolDescription: string;
}

export interface ToolDescriptionRecommendationResult {
  tools?: ToolDescriptionRecommendationToolResult[];
  configurationBundle?: RecommendationResultConfigurationBundle;
  errorCode?: string;
  errorMessage?: string;
}

export interface RecommendationResult {
  systemPromptRecommendationResult?: SystemPromptRecommendationResult;
  toolDescriptionRecommendationResult?: ToolDescriptionRecommendationResult;
}

// ============================================================================
// Types — API Options & Results
// ============================================================================

export interface StartRecommendationOptions {
  region: string;
  name: string;
  description?: string;
  type: RecommendationType;
  recommendationConfig: RecommendationConfig;
  kmsKeyArn?: string;
  clientToken?: string;
}

export interface StartRecommendationResult {
  recommendationId: string;
  recommendationArn: string;
  name: string;
  type: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  requestId?: string;
}

export interface GetRecommendationOptions {
  region: string;
  recommendationId: string;
}

export interface GetRecommendationResult {
  recommendationId: string;
  recommendationArn: string;
  name: string;
  description?: string;
  type: string;
  recommendationConfig?: RecommendationConfig;
  status: string;
  statusReasons?: string[];
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  recommendationResult?: RecommendationResult;
  requestId?: string;
}

export interface ListRecommendationsOptions {
  region: string;
  status?: string;
  maxResults?: number;
  nextToken?: string;
}

export interface RecommendationSummary {
  recommendationId: string;
  recommendationArn: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ListRecommendationsResult {
  recommendationSummaries: RecommendationSummary[];
  nextToken?: string;
}

export interface DeleteRecommendationOptions {
  region: string;
  recommendationId: string;
}

export interface DeleteRecommendationResult {
  recommendationId: string;
  status: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

/**
 * Resolve the DP endpoint for the Recommendation API.
 *
 * TEMPORARY: All Recommendation endpoints are on the Data Plane.
 * Set AGENTCORE_STAGE=beta|gamma to target pre-release environments.
 */
function getDataPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapdp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapdp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore.${region}.${dnsSuffix(region)}`;
}

async function signedRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
}): Promise<{ data: unknown; status: number; requestId?: string }> {
  const { region, method, path, body } = options;
  const endpoint = getDataPlaneEndpoint(region);
  const url = new URL(path, endpoint);

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const request = new HttpRequest({
    method,
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname,
    ...(Object.keys(query).length > 0 && { query }),
    headers: {
      'Content-Type': 'application/json',
      host: url.hostname,
    },
    ...(body && { body }),
  });

  const credentials = getCredentialProvider() ?? defaultProvider();
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region,
    credentials,
    sha256: Sha256,
  });

  const signedReq = await signer.sign(request);

  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: signedReq.headers as Record<string, string>,
    ...(body && { body }),
  });

  const requestId = response.headers.get('x-amzn-requestid') ?? 'unknown';

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Recommendation API error (${response.status}): ${errorBody} [requestId: ${requestId}]`);
  }

  if (response.status === 204) return { data: {}, status: 204, requestId };
  return { data: await response.json(), status: response.status, requestId };
}

// ============================================================================
// API Operations
// ============================================================================

/**
 * Start a new recommendation (async — returns 202).
 * Creates an ARN-able resource that progresses through:
 *   PENDING → IN_PROGRESS → COMPLETED | FAILED
 */
export async function startRecommendation(options: StartRecommendationOptions): Promise<StartRecommendationResult> {
  const body = JSON.stringify({
    name: options.name,
    ...(options.description && { description: options.description }),
    type: options.type,
    recommendationConfig: options.recommendationConfig,
    ...(options.kmsKeyArn && { kmsKeyArn: options.kmsKeyArn }),
    ...(options.clientToken && { clientToken: options.clientToken }),
  });

  const { data, requestId } = await signedRequest({
    region: options.region,
    method: 'POST',
    path: '/recommendations',
    body,
  });

  const result = data as StartRecommendationResult;
  if (requestId) result.requestId = requestId;
  return result;
}

/**
 * Get recommendation status and results.
 * When status is COMPLETED, recommendationResult contains the optimized artifact.
 */
export async function getRecommendation(options: GetRecommendationOptions): Promise<GetRecommendationResult> {
  const { data, requestId } = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/recommendations/${options.recommendationId}`,
  });

  const result = data as GetRecommendationResult;
  if (requestId) result.requestId = requestId;
  return result;
}

/**
 * List recommendations with optional filtering and pagination.
 */
export async function listRecommendations(options: ListRecommendationsOptions): Promise<ListRecommendationsResult> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);

  const query = params.toString();
  const path = `/recommendations${query ? `?${query}` : ''}`;

  const { data } = await signedRequest({
    region: options.region,
    method: 'GET',
    path,
  });

  const result = data as ListRecommendationsResult;
  return {
    recommendationSummaries: result.recommendationSummaries ?? [],
    nextToken: result.nextToken,
  };
}

/**
 * Delete a recommendation. Also stops in-progress recommendations
 * (stop-via-delete pattern — no separate Stop API).
 */
export async function deleteRecommendation(options: DeleteRecommendationOptions): Promise<DeleteRecommendationResult> {
  const { data } = await signedRequest({
    region: options.region,
    method: 'DELETE',
    path: `/recommendations/${options.recommendationId}`,
  });

  return data as DeleteRecommendationResult;
}
