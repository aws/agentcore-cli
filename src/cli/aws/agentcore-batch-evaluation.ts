/**
 * AWS client wrappers for BatchEvaluation operations.
 *
 * The BatchEvaluation API is a flat, stateless model — no persistent "job" resource.
 * Each batch evaluation is started, polled, and optionally stopped.
 *
 * Endpoints:
 *   POST   /evaluations/batch-evaluate                       → StartBatchEvaluation
 *   GET    /evaluations/batch-evaluate/{batchEvaluationId}    → GetBatchEvaluation
 *   GET    /evaluations/batch-evaluate                        → ListBatchEvaluations
 *   POST   /evaluations/batch-evaluate/{batchEvaluationId}/stop → StopBatchEvaluation
 *   DELETE /evaluations/batch-evaluate/{batchEvaluationId}    → DeleteBatchEvaluation
 *
 * Uses direct HTTP requests with SigV4 signing (service: bedrock-agentcore).
 */
import { getCredentialProvider } from './account';
import { dnsSuffix } from './partition';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

// ============================================================================
// Types
// ============================================================================

export interface SessionFilterConfig {
  startTime?: string;
  endTime?: string;
}

export interface CloudWatchFilterConfig {
  sessionIds?: string[];
  timeRange?: SessionFilterConfig;
}

export interface CloudWatchLogsSource {
  serviceNames: string[];
  logGroupNames: string[];
  filterConfig?: CloudWatchFilterConfig;
}

export interface DataSourceConfig {
  cloudWatchLogs?: CloudWatchLogsSource;
  onlineEvaluationConfigSource?: Record<string, unknown>;
}

export interface Evaluator {
  evaluatorId: string;
}

export interface GroundTruthAssertion {
  text: string;
}

export interface GroundTruthTurnInput {
  prompt: string;
}

export interface GroundTruthTurnExpectedResponse {
  text: string;
}

export interface GroundTruthTurn {
  input: GroundTruthTurnInput;
  expectedResponse: GroundTruthTurnExpectedResponse;
}

export interface ExpectedTrajectory {
  toolNames: string[];
}

export interface InlineGroundTruth {
  assertions?: GroundTruthAssertion[];
  expectedTrajectory?: ExpectedTrajectory;
  turns?: GroundTruthTurn[];
}

export interface GroundTruth {
  inline: InlineGroundTruth;
}

export interface SessionMetadataEntry {
  sessionId: string;
  testScenarioId?: string;
  groundTruth?: GroundTruth;
  metadata?: Record<string, string>;
}

export interface EvaluationMetadata {
  sessionMetadata?: SessionMetadataEntry[];
}

export interface StartBatchEvaluationOptions {
  region: string;
  name: string;
  evaluators: Evaluator[];
  dataSourceConfig: DataSourceConfig;
  evaluationMetadata?: EvaluationMetadata;
  description?: string;
  clientToken?: string;
}

export interface StartBatchEvaluationResult {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  name: string;
  status: string;
  createdAt?: string;
}

export interface GetBatchEvaluationOptions {
  region: string;
  batchEvaluationId: string;
}

export interface CloudWatchOutputConfig {
  logGroupName: string;
  logStreamName: string;
}

export interface OutputConfig {
  cloudWatchConfig?: CloudWatchOutputConfig;
}

export interface EvaluatorSummary {
  evaluatorId: string;
  statistics?: {
    averageScore?: number;
    averageTokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  totalEvaluated?: number;
  totalFailed?: number;
}

export interface EvaluationResults {
  evaluatorSummaries?: EvaluatorSummary[];
  numberOfSessionsCompleted?: number;
  numberOfSessionsFailed?: number;
  numberOfSessionsInProgress?: number;
  totalNumberOfSessions?: number;
  numberOfSessionsIgnored?: number;
}

export interface GetBatchEvaluationResult {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  name: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  evaluators?: Evaluator[];
  dataSourceConfig?: DataSourceConfig;
  outputConfig?: OutputConfig;
  evaluationResults?: EvaluationResults;
  errorDetails?: string[];
  description?: string;
}

export interface BatchEvaluationResultEntry {
  evaluatorId: string;
  score?: number;
  label?: string;
  explanation?: string;
  error?: string;
}

export interface ListBatchEvaluationsOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface BatchEvaluationSummary {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  name: string;
  status: string;
  createdAt?: string;
  description?: string;
  evaluators?: Evaluator[];
  evaluationResults?: EvaluationResults;
  errorDetails?: string[];
}

export interface ListBatchEvaluationsResult {
  batchEvaluations: BatchEvaluationSummary[];
  nextToken?: string;
}

export interface StopBatchEvaluationOptions {
  region: string;
  batchEvaluationId: string;
}

export interface StopBatchEvaluationResult {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  status: string;
  description?: string;
}

export interface DeleteBatchEvaluationOptions {
  region: string;
  batchEvaluationId: string;
}

export interface DeleteBatchEvaluationResult {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  status: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

function getEndpoint(region: string): string {
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
}): Promise<{ data: unknown; status: number }> {
  const { region, method, path, body } = options;
  const endpoint = getEndpoint(region);
  const url = new URL(path, endpoint);

  const request = new HttpRequest({
    method,
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname + url.search,
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

  const response = await fetch(`${endpoint}${url.pathname}${url.search}`, {
    method,
    headers: signedReq.headers as Record<string, string>,
    ...(body && { body }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`BatchEvaluation API error (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) return { data: {}, status: 204 };
  return { data: await response.json(), status: response.status };
}

// ============================================================================
// API Operations
// ============================================================================

/**
 * Start a batch evaluation (async — returns immediately with an ID to poll).
 */
export async function startBatchEvaluation(options: StartBatchEvaluationOptions): Promise<StartBatchEvaluationResult> {
  const body: Record<string, unknown> = {
    batchEvaluationName: options.name,
    evaluators: options.evaluators,
    dataSourceConfig: options.dataSourceConfig,
  };
  if (options.evaluationMetadata) {
    body.evaluationMetadata = options.evaluationMetadata;
  }
  if (options.description) {
    body.description = options.description;
  }
  if (options.clientToken) {
    body.clientToken = options.clientToken;
  }

  const { data } = await signedRequest({
    region: options.region,
    method: 'POST',
    path: '/evaluations/batch-evaluate',
    body: JSON.stringify(body),
  });

  const raw = data as Record<string, unknown>;
  return {
    batchEvaluationId: (raw.batchEvaluationId ?? '') as string,
    batchEvaluationArn: (raw.batchEvaluationArn ?? '') as string,
    name: (raw.batchEvaluationName ?? '') as string,
    status: (raw.status ?? '') as string,
    createdAt: raw.createdAt as string | undefined,
  };
}

/**
 * Get status and results of a batch evaluation.
 */
export async function getBatchEvaluation(options: GetBatchEvaluationOptions): Promise<GetBatchEvaluationResult> {
  const { data } = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/evaluations/batch-evaluate/${options.batchEvaluationId}`,
  });

  const raw = data as Record<string, unknown>;
  return {
    batchEvaluationId: (raw.batchEvaluationId ?? '') as string,
    batchEvaluationArn: (raw.batchEvaluationArn ?? '') as string,
    name: (raw.batchEvaluationName ?? '') as string,
    status: (raw.status ?? '') as string,
    createdAt: raw.createdAt as string | undefined,
    updatedAt: raw.updatedAt as string | undefined,
    evaluators: raw.evaluators as Evaluator[] | undefined,
    dataSourceConfig: raw.dataSourceConfig as DataSourceConfig | undefined,
    outputConfig: raw.outputConfig as OutputConfig | undefined,
    evaluationResults: raw.evaluationResults as EvaluationResults | undefined,
    errorDetails: raw.errorDetails as string[] | undefined,
    description: raw.description as string | undefined,
  };
}

/**
 * List batch evaluations.
 */
export async function listBatchEvaluations(options: ListBatchEvaluationsOptions): Promise<ListBatchEvaluationsResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);

  const query = params.toString();
  const path = `/evaluations/batch-evaluate${query ? `?${query}` : ''}`;

  const { data } = await signedRequest({
    region: options.region,
    method: 'GET',
    path,
  });

  const result = data as ListBatchEvaluationsResult;
  return {
    batchEvaluations: result.batchEvaluations ?? [],
    nextToken: result.nextToken,
  };
}

/**
 * Stop a running batch evaluation.
 */
export async function stopBatchEvaluation(options: StopBatchEvaluationOptions): Promise<StopBatchEvaluationResult> {
  const { data } = await signedRequest({
    region: options.region,
    method: 'POST',
    path: `/evaluations/batch-evaluate/${options.batchEvaluationId}/stop`,
  });

  const raw = data as Record<string, unknown>;
  return {
    batchEvaluationId: (raw.batchEvaluationId ?? '') as string,
    batchEvaluationArn: (raw.batchEvaluationArn ?? '') as string,
    status: (raw.status ?? '') as string,
    description: raw.description as string | undefined,
  };
}

/**
 * Delete a batch evaluation.
 */
export async function deleteBatchEvaluation(
  options: DeleteBatchEvaluationOptions
): Promise<DeleteBatchEvaluationResult> {
  const { data } = await signedRequest({
    region: options.region,
    method: 'DELETE',
    path: `/evaluations/batch-evaluate/${options.batchEvaluationId}`,
  });

  const raw = data as Record<string, unknown>;
  return {
    batchEvaluationId: (raw.batchEvaluationId ?? '') as string,
    batchEvaluationArn: (raw.batchEvaluationArn ?? '') as string,
    status: (raw.status ?? '') as string,
  };
}

/**
 * Generate a client token for idempotency.
 */
export function generateClientToken(): string {
  return crypto.randomUUID();
}
