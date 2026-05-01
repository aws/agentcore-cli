/**
 * AWS client wrappers for HTTP Gateway control plane operations.
 *
 * HTTP gateways are required for A/B testing because MCP gateways
 * don't emit spans for treatment propagation. These wrappers use
 * direct HTTP requests with SigV4 signing against the control plane.
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

// ── Create Gateway ─────────────────────────────────────────────────────────

export interface CreateHttpGatewayOptions {
  region: string;
  name: string;
  roleArn: string;
}

export interface CreateHttpGatewayResult {
  gatewayId: string;
  gatewayArn: string;
  name: string;
  status: string;
}

// ── Create Gateway Target ──────────────────────────────────────────────────

export interface CreateHttpGatewayTargetOptions {
  region: string;
  gatewayId: string;
  targetName: string;
  runtimeArn: string;
  qualifier?: string;
}

export interface CreateHttpGatewayTargetResult {
  targetId: string;
  name: string;
  status: string;
}

// ── Get Gateway ────────────────────────────────────────────────────────────

export interface GetHttpGatewayOptions {
  region: string;
  gatewayId: string;
}

export interface GetHttpGatewayResult {
  gatewayId: string;
  gatewayArn: string;
  gatewayUrl?: string;
  name: string;
  status: string;
  authorizerType?: string;
  roleArn?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Get Gateway Target ─────────────────────────────────────────────────────

export interface GetHttpGatewayTargetOptions {
  region: string;
  gatewayId: string;
  targetId: string;
}

export interface GetHttpGatewayTargetResult {
  targetId: string;
  name: string;
  status: string;
  targetConfiguration?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

// ── List Gateways ──────────────────────────────────────────────────────────

export interface ListHttpGatewaysOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface HttpGatewaySummary {
  gatewayId: string;
  gatewayArn: string;
  name: string;
  status: string;
}

export interface ListHttpGatewaysResult {
  gateways: HttpGatewaySummary[];
  nextToken?: string;
}

// ── List Gateway Targets ──────────────────────────────────────────────────

export interface ListHttpGatewayTargetsOptions {
  region: string;
  gatewayId: string;
  maxResults?: number;
}

export interface HttpGatewayTargetSummary {
  targetId: string;
  name: string;
  status: string;
}

export interface ListHttpGatewayTargetsResult {
  targets: HttpGatewayTargetSummary[];
}

// ── Delete Gateway Target ──────────────────────────────────────────────────

export interface DeleteHttpGatewayTargetOptions {
  region: string;
  gatewayId: string;
  targetId: string;
}

// ── Delete Gateway ─────────────────────────────────────────────────────────

export interface DeleteHttpGatewayOptions {
  region: string;
  gatewayId: string;
}

// ── Wait for Target Ready ──────────────────────────────────────────────────

export interface WaitForTargetReadyOptions {
  region: string;
  gatewayId: string;
  targetId: string;
  /** Maximum time to wait in milliseconds. Defaults to 120000 (120s). */
  timeoutMs?: number;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

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
    throw new Error(`HttpGateway API error (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

// ============================================================================
// Control Plane Operations
// ============================================================================

export async function createHttpGateway(options: CreateHttpGatewayOptions): Promise<CreateHttpGatewayResult> {
  const body = JSON.stringify({
    name: options.name,
    authorizerType: 'AWS_IAM',
    roleArn: options.roleArn,
    clientToken: randomUUID(),
  });

  try {
    return (await signedRequest({
      region: options.region,
      method: 'POST',
      path: '/gateways',
      body,
    })) as CreateHttpGatewayResult;
  } catch (err) {
    throw new Error(
      `Failed to create HTTP gateway "${options.name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function createHttpGatewayTarget(
  options: CreateHttpGatewayTargetOptions
): Promise<CreateHttpGatewayTargetResult> {
  const body = JSON.stringify({
    name: options.targetName,
    clientToken: randomUUID(),
    targetConfiguration: {
      http: {
        agentcoreRuntime: {
          arn: options.runtimeArn,
          qualifier: options.qualifier ?? 'DEFAULT',
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
  });

  try {
    return (await signedRequest({
      region: options.region,
      method: 'POST',
      path: `/gateways/${options.gatewayId}/targets`,
      body,
    })) as CreateHttpGatewayTargetResult;
  } catch (err) {
    // Fallback: retry with legacy field name if the new name is not yet supported
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ValidationException') || msg.includes('400')) {
      const legacyBody = JSON.stringify({
        name: options.targetName,
        clientToken: randomUUID(),
        targetConfiguration: {
          http: {
            runtimeTargetConfiguration: {
              arn: options.runtimeArn,
              qualifier: options.qualifier ?? 'DEFAULT',
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      });
      try {
        return (await signedRequest({
          region: options.region,
          method: 'POST',
          path: `/gateways/${options.gatewayId}/targets`,
          body: legacyBody,
        })) as CreateHttpGatewayTargetResult;
      } catch {
        // Fall through to original error
      }
    }
    throw new Error(`Failed to create target "${options.targetName}" in gateway ${options.gatewayId}: ${msg}`);
  }
}

export async function getHttpGateway(options: GetHttpGatewayOptions): Promise<GetHttpGatewayResult> {
  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/gateways/${options.gatewayId}`,
  });

  return data as GetHttpGatewayResult;
}

export async function getHttpGatewayTarget(options: GetHttpGatewayTargetOptions): Promise<GetHttpGatewayTargetResult> {
  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/gateways/${options.gatewayId}/targets/${options.targetId}`,
  });

  return data as GetHttpGatewayTargetResult;
}

export async function listHttpGateways(options: ListHttpGatewaysOptions): Promise<ListHttpGatewaysResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  if (options.nextToken) params.set('nextToken', options.nextToken);
  const query = params.toString();

  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/gateways${query ? `?${query}` : ''}`,
  });

  const result = data as ListHttpGatewaysResult;
  return {
    gateways: result.gateways ?? [],
    nextToken: result.nextToken,
  };
}

/**
 * List all HTTP gateways, paginating through all results.
 */
export async function listAllHttpGateways(options: { region: string }): Promise<HttpGatewaySummary[]> {
  const all: HttpGatewaySummary[] = [];
  let nextToken: string | undefined;

  do {
    const result = await listHttpGateways({ region: options.region, maxResults: 100, nextToken });
    all.push(...result.gateways);
    nextToken = result.nextToken;
  } while (nextToken);

  return all;
}

export async function listHttpGatewayTargets(
  options: ListHttpGatewayTargetsOptions
): Promise<ListHttpGatewayTargetsResult> {
  const params = new URLSearchParams();
  if (options.maxResults) params.set('maxResults', String(options.maxResults));
  const query = params.toString();

  const data = await signedRequest({
    region: options.region,
    method: 'GET',
    path: `/gateways/${options.gatewayId}/targets${query ? `?${query}` : ''}`,
  });

  const result = data as Record<string, unknown>;
  return {
    targets: (result.items ?? result.targets ?? []) as HttpGatewayTargetSummary[],
  };
}

export async function deleteHttpGatewayTarget(
  options: DeleteHttpGatewayTargetOptions
): Promise<{ success: boolean; error?: string }> {
  try {
    await signedRequest({
      region: options.region,
      method: 'DELETE',
      path: `/gateways/${options.gatewayId}/targets/${options.targetId}`,
    });

    // Wait for target to be fully deleted before returning.
    // Gateway deletion fails if targets still exist in DELETING state.
    const timeoutMs = 60_000;
    const startTime = Date.now();
    let delayMs = 2_000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        await getHttpGatewayTarget({
          region: options.region,
          gatewayId: options.gatewayId,
          targetId: options.targetId,
        });
        // Target still exists — keep waiting
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('(404)') || msg.includes('not found')) {
          return { success: true }; // Target confirmed deleted
        }
        // Transient error — keep polling
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)));
      delayMs = Math.min(delayMs * 2, 8_000);
    }

    // Polling timed out — target may still be deleting
    return { success: false, error: `Timed out waiting for target ${options.targetId} to be fully deleted` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteHttpGateway(
  options: DeleteHttpGatewayOptions
): Promise<{ success: boolean; error?: string }> {
  try {
    await signedRequest({
      region: options.region,
      method: 'DELETE',
      path: `/gateways/${options.gatewayId}`,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Terminal states that indicate a resource will never become READY. */
const TERMINAL_FAILURE_STATES = ['FAILED', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETING', 'DELETED'] as const;

export async function waitForGatewayReady(options: {
  region: string;
  gatewayId: string;
  timeoutMs?: number;
}): Promise<GetHttpGatewayResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startTime = Date.now();
  let delayMs = 2_000;

  while (Date.now() - startTime < timeoutMs) {
    const gateway = await getHttpGateway({
      region: options.region,
      gatewayId: options.gatewayId,
    });

    if (gateway.status === 'READY') return gateway;

    if ((TERMINAL_FAILURE_STATES as readonly string[]).includes(gateway.status)) {
      throw new Error(
        `Gateway ${options.gatewayId} reached terminal state '${gateway.status}' and will not become READY`
      );
    }

    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining <= 0) break;

    await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)));
    delayMs = Math.min(delayMs * 2, 16_000);
  }

  throw new Error(
    `Timed out waiting for gateway ${options.gatewayId} to become READY after ${Math.round(timeoutMs / 1000)}s`
  );
}

export async function waitForTargetReady(options: WaitForTargetReadyOptions): Promise<GetHttpGatewayTargetResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startTime = Date.now();
  let delayMs = 2_000;

  while (Date.now() - startTime < timeoutMs) {
    let target;
    try {
      target = await getHttpGatewayTarget({
        region: options.region,
        gatewayId: options.gatewayId,
        targetId: options.targetId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('(404)')) {
        throw new Error(
          `Target ${options.targetId} not found during readiness poll — it may have been deleted externally`
        );
      }
      // Retry on transient server errors
      if (/\(5\d\d\)/.test(msg)) {
        // Continue polling — transient error
        const remaining = timeoutMs - (Date.now() - startTime);
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 16_000);
        continue;
      }
      throw err;
    }

    if (target.status === 'READY') return target;

    if ((TERMINAL_FAILURE_STATES as readonly string[]).includes(target.status)) {
      throw new Error(
        `Target ${options.targetId} in gateway ${options.gatewayId} reached terminal state '${target.status}' and will not become READY`
      );
    }

    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining <= 0) break;

    await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)));
    delayMs = Math.min(delayMs * 2, 16_000);
  }

  throw new Error(
    `Timed out waiting for target ${options.targetId} to become READY after ${Math.round(timeoutMs / 1000)}s`
  );
}
