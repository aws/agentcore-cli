/**
 * AWS client wrappers for AB Test data plane operations.
 *
 * Uses the AgentCore Evaluation DataPlane API (bedrock-agentcore)
 * with direct HTTP requests and SigV4 signing.
 */
import { getCredentialProvider } from './account';
import { dnsSuffix } from './partition';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface ABTestVariant {
  name: 'C' | 'T1';
  weight: number;
  variantConfiguration: {
    configurationBundle?: {
      bundleArn: string;
      bundleVersion: string;
    };
    target?: {
      name: string;
    };
  };
}

export type ABTestEvaluationConfig =
  | { onlineEvaluationConfigArn: string }
  | {
      perVariantOnlineEvaluationConfig: {
        name: 'C' | 'T1';
        onlineEvaluationConfigArn: string;
      }[];
    };

export interface GatewayFilter {
  targetPaths: string[];
}

export interface TrafficAllocationConfig {
  routeOnHeader: {
    headerName: string;
  };
}

export interface ConfidenceInterval {
  lower?: number;
  upper?: number;
}

export interface ControlStats {
  treatmentName: string;
  sampleSize: number;
  mean: number;
}

export interface VariantResult {
  treatmentName: string;
  sampleSize: number;
  mean: number;
  absoluteChange?: number;
  percentChange?: number;
  pValue?: number;
  confidenceInterval?: ConfidenceInterval;
  isSignificant: boolean;
}

export interface EvaluatorMetric {
  evaluatorArn: string;
  controlStats: ControlStats;
  variantResults: VariantResult[];
}

export interface ABTestResults {
  analysisTimestamp?: string;
  evaluatorMetrics: EvaluatorMetric[];
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateABTestOptions {
  region: string;
  name: string;
  description?: string;
  gatewayArn: string;
  roleArn: string;
  variants: ABTestVariant[];
  evaluationConfig: ABTestEvaluationConfig;
  gatewayFilter?: GatewayFilter;
  trafficAllocationConfig?: TrafficAllocationConfig;
  maxDurationDays?: number;
  enableOnCreate?: boolean;
}

export interface CreateABTestResult {
  abTestId: string;
  abTestArn: string;
  name?: string;
  status: string;
  executionStatus: string;
  createdAt: string;
}

// ── Get ─────────────────────────────────────────────────────────────────────

export interface GetABTestOptions {
  region: string;
  abTestId: string;
}

export interface GetABTestResult {
  abTestId: string;
  abTestArn: string;
  name: string;
  description?: string;
  status: string;
  executionStatus: string;
  gatewayArn: string;
  roleArn: string;
  variants: ABTestVariant[];
  evaluationConfig: ABTestEvaluationConfig;
  trafficAllocationConfig?: TrafficAllocationConfig;
  maxDurationDays?: number;
  currentRunId?: string;
  stopReason?: string;
  failureReason?: string;
  startedAt?: string;
  stoppedAt?: string;
  maxDurationExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  results?: ABTestResults;
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface UpdateABTestOptions {
  region: string;
  abTestId: string;
  name?: string;
  description?: string;
  variants?: ABTestVariant[];
  trafficAllocationConfig?: TrafficAllocationConfig;
  evaluationConfig?: ABTestEvaluationConfig;
  maxDurationDays?: number;
  executionStatus?: 'PAUSED' | 'RUNNING' | 'STOPPED';
  roleArn?: string;
}

export interface UpdateABTestResult {
  abTestId: string;
  abTestArn: string;
  status: string;
  executionStatus: string;
  failureReason?: string;
  updatedAt: string;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface DeleteABTestOptions {
  region: string;
  abTestId: string;
}

// ── List ────────────────────────────────────────────────────────────────────

export interface ListABTestsOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface ABTestSummary {
  abTestId: string;
  abTestArn: string;
  name: string;
  description?: string;
  status: string;
  executionStatus: string;
  gatewayArn?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListABTestsResult {
  abTests: ABTestSummary[];
  nextToken?: string;
}

// ============================================================================
// HTTP signing helpers
// ============================================================================

function getDataPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapdp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapdp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore.${region}.${dnsSuffix(region)}`;
}

async function signedRequestToEndpoint(
  endpoint: string,
  options: {
    region: string;
    method: string;
    path: string;
    body?: string;
  }
): Promise<unknown> {
  const { region, method, path, body } = options;
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
  const service = 'bedrock-agentcore';
  const signer = new SignatureV4({
    service,
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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ABTest API error (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

/** Data plane request — used for GetABTest (includes results/metrics). */
async function dpRequest(options: { region: string; method: string; path: string; body?: string }): Promise<unknown> {
  return signedRequestToEndpoint(getDataPlaneEndpoint(options.region), options);
}

// ============================================================================
// Control Plane Operations (CRUD)
// ============================================================================

export async function createABTest(options: CreateABTestOptions): Promise<CreateABTestResult> {
  const body = JSON.stringify({
    name: options.name,
    clientToken: randomUUID(),
    gatewayArn: options.gatewayArn,
    roleArn: options.roleArn,
    variants: options.variants,
    evaluationConfig: options.evaluationConfig,
    ...(options.description && { description: options.description }),
    ...(options.gatewayFilter && { gatewayFilter: options.gatewayFilter }),
    ...(options.trafficAllocationConfig && { trafficAllocationConfig: options.trafficAllocationConfig }),
    ...(options.maxDurationDays !== undefined && { maxDurationDays: options.maxDurationDays }),
    ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
  });

  const result = await dpRequest({
    region: options.region,
    method: 'POST',
    path: '/ab-tests',
    body,
  });

  return result as CreateABTestResult;
}

export async function getABTest(options: GetABTestOptions): Promise<GetABTestResult> {
  // Data plane includes results/metrics in the response
  const data = await dpRequest({
    region: options.region,
    method: 'GET',
    path: `/ab-tests/${options.abTestId}`,
  });

  return data as GetABTestResult;
}

export async function updateABTest(options: UpdateABTestOptions): Promise<UpdateABTestResult> {
  const body: Record<string, unknown> = { clientToken: randomUUID() };
  if (options.name !== undefined) body.name = options.name;
  if (options.description !== undefined) body.description = options.description;
  if (options.variants !== undefined) body.variants = options.variants;
  if (options.trafficAllocationConfig !== undefined) body.trafficAllocationConfig = options.trafficAllocationConfig;
  if (options.evaluationConfig !== undefined) body.evaluationConfig = options.evaluationConfig;
  if (options.maxDurationDays !== undefined) body.maxDurationDays = options.maxDurationDays;
  if (options.executionStatus !== undefined) body.executionStatus = options.executionStatus;
  if (options.roleArn !== undefined) body.roleArn = options.roleArn;

  const data = await dpRequest({
    region: options.region,
    method: 'PUT',
    path: `/ab-tests/${options.abTestId}`,
    body: JSON.stringify(body),
  });

  return data as UpdateABTestResult;
}

export async function deleteABTest(options: DeleteABTestOptions): Promise<{ success: boolean; error?: string }> {
  try {
    await dpRequest({
      region: options.region,
      method: 'DELETE',
      path: `/ab-tests/${options.abTestId}`,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listABTests(options: ListABTestsOptions): Promise<ListABTestsResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);
  const query = params.toString();

  const data = await dpRequest({
    region: options.region,
    method: 'GET',
    path: `/ab-tests${query ? `?${query}` : ''}`,
  });

  const result = data as ListABTestsResult;
  return {
    abTests: result.abTests ?? [],
    nextToken: result.nextToken,
  };
}
