/**
 * AWS client wrappers for Dataset Management operations.
 *
 * The Dataset API lives on the control plane. Endpoints:
 *   GET    /datasets/{datasetId}                    → GetDataset
 *   GET    /datasets/{datasetId}/versions           → ListDatasetVersions
 *   POST   /datasets/{datasetId}/versions           → CreateDatasetVersion
 *   POST   /datasets/{datasetId}/examples/add       → AddDatasetExamples
 *   POST   /datasets/{datasetId}/examples/update    → UpdateDatasetExamples
 *   POST   /datasets/{datasetId}/examples/delete    → DeleteDatasetExamples
 *   GET    /datasets/{datasetId}/examples           → ListDatasetExamples
 *
 * Uses direct HTTP requests with SigV4 signing against the control plane
 * because the @aws-sdk/client-bedrock-agentcore-control package does not yet
 * include Dataset commands.
 *
 * TODO: Migrate to @aws-sdk/client-bedrock-agentcore-control once Dataset
 * commands are available in the SDK. When that happens:
 * 1. Replace signedRequest() calls with SDK client commands
 *    (e.g., GetDatasetCommand, CreateDatasetVersionCommand, etc.)
 * 2. Remove the SigV4 signing helper and endpoint resolution logic
 * 3. Follow the pattern in agentcore-control.ts which already uses the SDK
 * 4. Keep the same exported function signatures so callers don't change
 */
import { getCredentialProvider } from './account';
import { controlPlaneEndpoint } from './stage-endpoint';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

// ============================================================================
// Types
// ============================================================================

export interface GetDatasetOptions {
  region: string;
  datasetId: string;
  version?: string;
}

export interface GetDatasetResult {
  datasetId: string;
  datasetArn: string;
  datasetName: string;
  datasetVersion: string;
  schemaType: string;
  status: string;
  draftStatus?: string;
  exampleCount: number;
  description?: string;
  downloadUrl?: string;
  downloadUrlExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDatasetVersionOptions {
  region: string;
  datasetId: string;
}

export interface CreateDatasetVersionResult {
  datasetArn: string;
  datasetId: string;
  datasetVersion: string;
  status: string;
  createdAt: number;
}

export interface ListDatasetVersionsOptions {
  region: string;
  datasetId: string;
}

export interface DatasetVersionSummary {
  datasetVersion: string;
  exampleCount: number;
  status?: string;
  failureReason?: string;
  createdAt: number;
}

export interface ListDatasetVersionsResult {
  versions: DatasetVersionSummary[];
}

export interface AddDatasetExamplesOptions {
  region: string;
  datasetId: string;
  examples: Record<string, unknown>[];
  /** Idempotency token (8-hour service-side dedup). Reuse across retries of the same batch. */
  clientToken?: string;
}

export interface AddDatasetExamplesResult {
  addedCount: number;
  exampleIds: string[];
  status: string;
}

export interface UpdateDatasetExamplesOptions {
  region: string;
  datasetId: string;
  examples: ({ exampleId: string } & Record<string, unknown>)[];
  /** Idempotency token (8-hour service-side dedup). Reuse across retries of the same batch. */
  clientToken?: string;
}

export interface UpdateDatasetExamplesResult {
  updatedCount: number;
  status: string;
}

export interface DeleteDatasetExamplesOptions {
  region: string;
  datasetId: string;
  exampleIds: string[];
  /** Idempotency token (8-hour service-side dedup). Reuse across retries of the same batch. */
  clientToken?: string;
}

export interface DeleteDatasetExamplesResult {
  deletedCount: number;
  status: string;
}

export interface DatasetExampleSummary {
  exampleId: string;
  [key: string]: unknown;
}

export interface ListDatasetExamplesOptions {
  region: string;
  datasetId: string;
  maxResults?: number;
  nextToken?: string;
}

export interface ListDatasetExamplesResult {
  examples: DatasetExampleSummary[];
  nextToken?: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

async function signedRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
}): Promise<unknown> {
  const { region, method, path, body } = options;
  const endpoint = controlPlaneEndpoint(region);
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Dataset API error (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

// ============================================================================
// Dataset Operations
// ============================================================================

/**
 * Get dataset metadata and download URL.
 * Pass `version` to get a specific published version (e.g. "1", "2").
 * Omit `version` to get DRAFT.
 */
export async function getDataset(options: GetDatasetOptions): Promise<GetDatasetResult> {
  const { region, datasetId, version } = options;
  const params = version ? `?datasetVersion=${version}` : '';

  return (await signedRequest({
    region,
    method: 'GET',
    path: `/datasets/${datasetId}${params}`,
  })) as GetDatasetResult;
}

/**
 * Create a new immutable version from the current DRAFT.
 */
export async function createDatasetVersion(options: CreateDatasetVersionOptions): Promise<CreateDatasetVersionResult> {
  const { region, datasetId } = options;

  return (await signedRequest({
    region,
    method: 'POST',
    path: `/datasets/${datasetId}/versions`,
    body: '{}',
  })) as CreateDatasetVersionResult;
}

/**
 * List all published versions for a dataset.
 */
export async function listDatasetVersions(options: ListDatasetVersionsOptions): Promise<ListDatasetVersionsResult> {
  const { region, datasetId } = options;

  return (await signedRequest({
    region,
    method: 'GET',
    path: `/datasets/${datasetId}/versions`,
  })) as ListDatasetVersionsResult;
}

/**
 * Add examples to a dataset's DRAFT.
 */
export async function addDatasetExamples(options: AddDatasetExamplesOptions): Promise<AddDatasetExamplesResult> {
  const { region, datasetId, examples, clientToken } = options;
  const body = JSON.stringify({
    source: {
      inlineExamples: { examples },
    },
    ...(clientToken && { clientToken }),
  });

  return (await signedRequest({
    region,
    method: 'POST',
    path: `/datasets/${datasetId}/examples/add`,
    body,
  })) as AddDatasetExamplesResult;
}

/**
 * Update existing examples in a dataset's DRAFT by exampleId.
 */
export async function updateDatasetExamples(
  options: UpdateDatasetExamplesOptions
): Promise<UpdateDatasetExamplesResult> {
  const { region, datasetId, examples, clientToken } = options;
  const body = JSON.stringify({
    examples,
    ...(clientToken && { clientToken }),
  });

  return (await signedRequest({
    region,
    method: 'POST',
    path: `/datasets/${datasetId}/examples/update`,
    body,
  })) as UpdateDatasetExamplesResult;
}

/**
 * Delete examples from a dataset's DRAFT by exampleId.
 */
export async function deleteDatasetExamples(
  options: DeleteDatasetExamplesOptions
): Promise<DeleteDatasetExamplesResult> {
  const { region, datasetId, exampleIds, clientToken } = options;
  const body = JSON.stringify({
    exampleIds,
    ...(clientToken && { clientToken }),
  });

  return (await signedRequest({
    region,
    method: 'POST',
    path: `/datasets/${datasetId}/examples/delete`,
    body,
  })) as DeleteDatasetExamplesResult;
}

/**
 * List examples for a dataset (one page).
 */
export async function listDatasetExamples(options: ListDatasetExamplesOptions): Promise<ListDatasetExamplesResult> {
  const { region, datasetId, maxResults, nextToken } = options;
  const params = new URLSearchParams();
  if (maxResults) params.set('maxResults', String(maxResults));
  if (nextToken) params.set('nextToken', nextToken);
  const query = params.toString();

  const data = (await signedRequest({
    region,
    method: 'GET',
    path: `/datasets/${datasetId}/examples${query ? `?${query}` : ''}`,
  })) as { examples?: DatasetExampleSummary[]; nextToken?: string };

  return {
    examples: data.examples ?? [],
    nextToken: data.nextToken,
  };
}

/**
 * Delete a specific published version of a dataset.
 */
export async function deleteDatasetVersionApi(options: {
  region: string;
  datasetId: string;
  version: string;
}): Promise<void> {
  const { region, datasetId, version } = options;

  await signedRequest({
    region,
    method: 'DELETE',
    path: `/datasets/${datasetId}?datasetVersion=${version}`,
  });
}

/**
 * List all examples for a dataset, paginating through all results.
 */
export async function listAllDatasetExamples(options: {
  region: string;
  datasetId: string;
}): Promise<DatasetExampleSummary[]> {
  const all: DatasetExampleSummary[] = [];
  let nextToken: string | undefined;

  do {
    const result = await listDatasetExamples({
      region: options.region,
      datasetId: options.datasetId,
      maxResults: 100,
      nextToken,
    });
    all.push(...result.examples);
    nextToken = result.nextToken;
  } while (nextToken);

  return all;
}

/**
 * Download dataset content from a pre-signed S3 URL.
 *
 * Two modes:
 * - `buffer`: Returns full content as string (for push — needs in-memory diffing)
 * - `stream`: Streams directly to file on disk (for pull — avoids memory pressure on large datasets)
 */
export async function downloadDataset(downloadUrl: string, options: { mode: 'buffer' }): Promise<string>;
export async function downloadDataset(
  downloadUrl: string,
  options: { mode: 'stream'; filePath: string }
): Promise<number>;
export async function downloadDataset(
  downloadUrl: string,
  options: { mode: 'buffer' } | { mode: 'stream'; filePath: string }
): Promise<string | number> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download dataset (${response.status}): ${await response.text()}`);
  }

  if (options.mode === 'buffer') {
    return response.text();
  }

  // Stream mode: pipe response body → line counter → file
  const { Transform } = await import('node:stream');
  const { Readable } = await import('node:stream');
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');

  let lineCount = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      lineCount += chunk
        .toString()
        .split('\n')
        .filter((l: string) => l.trim()).length;
      this.push(chunk);
      cb();
    },
  });

  const nodeStream = Readable.fromWeb(response.body!);
  const fileStream = createWriteStream(options.filePath);
  await pipeline(nodeStream, counter, fileStream);

  return lineCount;
}
