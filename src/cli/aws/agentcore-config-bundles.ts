/**
 * AWS client wrappers for Configuration Bundle control plane operations.
 *
 * NOTE: The ConfigurationBundle API is not yet available in the
 * @aws-sdk/client-bedrock-agentcore-control SDK. These wrappers use
 * direct HTTP requests with SigV4 signing as an interim solution.
 * When the SDK adds ConfigurationBundle commands, migrate to the SDK client.
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

/** Freeform configuration for a component within a bundle. */
export interface ComponentConfiguration {
  configuration: Record<string, unknown>;
}

/** Map of component identifier (ARN) to its configuration. */
export type ComponentConfigurationMap = Record<string, ComponentConfiguration>;

/** Version lineage metadata for git-like versioning. */
export interface VersionLineageMetadata {
  parentVersionIds?: string[];
  branchName?: string;
  createdBy?: { name: string; arn?: string };
  commitMessage?: string;
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateConfigurationBundleOptions {
  region: string;
  bundleName: string;
  description?: string;
  components: ComponentConfigurationMap;
  branchName?: string;
  commitMessage?: string;
  createdBy?: { name: string; arn?: string };
}

export interface CreateConfigurationBundleResult {
  bundleArn: string;
  bundleId: string;
  versionId: string;
  createdAt: string;
}

// ── Get ─────────────────────────────────────────────────────────────────────

export interface GetConfigurationBundleOptions {
  region: string;
  bundleId: string;
  branchName?: string;
}

export interface GetConfigurationBundleResult {
  bundleArn: string;
  bundleId: string;
  bundleName: string;
  description?: string;
  versionId: string;
  components: ComponentConfigurationMap;
  lineageMetadata?: VersionLineageMetadata;
  createdAt: string;
  updatedAt: string;
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface UpdateConfigurationBundleOptions {
  region: string;
  bundleId: string;
  bundleName?: string;
  description?: string;
  components?: ComponentConfigurationMap;
  parentVersionIds?: string[];
  branchName?: string;
  commitMessage?: string;
  createdBy?: { name: string; arn?: string };
}

export interface UpdateConfigurationBundleResult {
  bundleArn: string;
  bundleId: string;
  versionId: string;
  updatedAt: string;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface DeleteConfigurationBundleOptions {
  region: string;
  bundleId: string;
}

// ── List ────────────────────────────────────────────────────────────────────

export interface ListConfigurationBundlesOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface ConfigurationBundleSummary {
  bundleArn: string;
  bundleId: string;
  bundleName: string;
  description?: string;
}

export interface ListConfigurationBundlesResult {
  bundles: ConfigurationBundleSummary[];
  nextToken?: string;
}

// ── Get Version ─────────────────────────────────────────────────────────────

export interface GetConfigurationBundleVersionOptions {
  region: string;
  bundleId: string;
  versionId: string;
}

export interface GetConfigurationBundleVersionResult {
  bundleArn: string;
  bundleId: string;
  bundleName: string;
  description?: string;
  versionId: string;
  components: ComponentConfigurationMap;
  lineageMetadata?: VersionLineageMetadata;
  createdAt: string;
  versionCreatedAt: string;
}

// ── List Versions ───────────────────────────────────────────────────────────

export interface ListConfigurationBundleVersionsFilter {
  branchName?: string;
  latestPerBranch?: boolean;
  createdByName?: string;
}

export interface ListConfigurationBundleVersionsOptions {
  region: string;
  bundleId: string;
  maxResults?: number;
  nextToken?: string;
  filter?: ListConfigurationBundleVersionsFilter;
}

export interface ConfigurationBundleVersionSummary {
  bundleArn: string;
  bundleId: string;
  versionId: string;
  lineageMetadata?: VersionLineageMetadata;
  versionCreatedAt: string;
}

export interface ListConfigurationBundleVersionsResult {
  versions: ConfigurationBundleVersionSummary[];
  nextToken?: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

// TODO: Remove beta/gamma endpoints before GA merge
function getControlPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapcp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapcp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore-control.${region}.${dnsSuffix(region)}`;
}

async function signedRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
}): Promise<unknown> {
  const { region, method, path, body } = options;
  const endpoint = getControlPlaneEndpoint(region);
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
    throw new Error(`ConfigurationBundle API error (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

// ============================================================================
// Control Plane Operations
// ============================================================================

export async function createConfigurationBundle(
  options: CreateConfigurationBundleOptions
): Promise<CreateConfigurationBundleResult> {
  const body = JSON.stringify({
    bundleName: options.bundleName,
    clientToken: randomUUID(),
    ...(options.description && { description: options.description }),
    components: options.components,
    ...(options.branchName && { branchName: options.branchName }),
    ...(options.commitMessage && { commitMessage: options.commitMessage }),
    ...(options.createdBy && { createdBy: options.createdBy }),
  });

  const result = await signedRequest({
    region: options.region,
    method: 'POST',
    path: '/configuration-bundles/create',
    body,
  });

  return result as CreateConfigurationBundleResult;
}

export async function getConfigurationBundle(
  options: GetConfigurationBundleOptions
): Promise<GetConfigurationBundleResult> {
  const params = new URLSearchParams();
  if (options.branchName) params.set('branchName', options.branchName);
  const query = params.toString();
  const path = `/configuration-bundles/${options.bundleId}${query ? `?${query}` : ''}`;

  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path,
  });

  return data as GetConfigurationBundleResult;
}

export async function updateConfigurationBundle(
  options: UpdateConfigurationBundleOptions
): Promise<UpdateConfigurationBundleResult> {
  const body: Record<string, unknown> = { clientToken: randomUUID() };
  if (options.bundleName !== undefined) body.bundleName = options.bundleName;
  if (options.description !== undefined) body.description = options.description;
  if (options.components !== undefined) body.components = options.components;
  if (options.parentVersionIds !== undefined) body.parentVersionIds = options.parentVersionIds;
  if (options.branchName !== undefined) body.branchName = options.branchName;
  if (options.commitMessage !== undefined) body.commitMessage = options.commitMessage;
  if (options.createdBy !== undefined) body.createdBy = options.createdBy;

  const data = await signedRequest({
    region: options.region,
    method: 'PUT',
    path: `/configuration-bundles/${options.bundleId}`,
    body: JSON.stringify(body),
  });

  return data as UpdateConfigurationBundleResult;
}

export async function deleteConfigurationBundle(options: DeleteConfigurationBundleOptions): Promise<void> {
  await signedRequest({
    region: options.region,
    method: 'DELETE',
    path: `/configuration-bundles/${options.bundleId}`,
  });
}

export async function listConfigurationBundles(
  options: ListConfigurationBundlesOptions
): Promise<ListConfigurationBundlesResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);
  const query = params.toString();

  const data = await signedRequest({
    region: options.region,
    method: 'POST',
    path: `/configuration-bundles${query ? `?${query}` : ''}`,
  });

  const result = data as ListConfigurationBundlesResult;
  return {
    bundles: result.bundles ?? [],
    nextToken: result.nextToken,
  };
}

export async function getConfigurationBundleVersion(
  options: GetConfigurationBundleVersionOptions
): Promise<GetConfigurationBundleVersionResult> {
  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/configuration-bundles/${options.bundleId}/versions/${options.versionId}`,
  });

  return data as GetConfigurationBundleVersionResult;
}

export async function listConfigurationBundleVersions(
  options: ListConfigurationBundleVersionsOptions
): Promise<ListConfigurationBundleVersionsResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);
  const query = params.toString();

  const body = options.filter ? JSON.stringify({ filter: options.filter }) : undefined;

  const data = await signedRequest({
    region: options.region,
    method: 'POST',
    path: `/configuration-bundles/${options.bundleId}/versions${query ? `?${query}` : ''}`,
    body,
  });

  const result = data as ListConfigurationBundleVersionsResult;
  return {
    versions: result.versions ?? [],
    nextToken: result.nextToken,
  };
}
