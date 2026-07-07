/**
 * Shared SigV4-signed HTTP client for AgentCore control plane and data plane APIs.
 * When the SDK adds native commands for new APIs, we will migrate callers to the SDK client.
 */
import { getCredentialProvider } from './account';
import { dnsSuffix } from './partition';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

const SERVICE = 'bedrock-agentcore';

export type ApiPlane = 'control' | 'data';

export interface ApiClientOptions {
  region: string;
  plane: ApiPlane;
}

export interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export class AgentCoreApiError extends Error {
  readonly statusCode: number;
  readonly requestId: string | undefined;
  readonly errorBody: string;

  constructor(statusCode: number, errorBody: string, requestId?: string) {
    const reqIdSuffix = requestId ? ` [requestId: ${requestId}]` : '';
    super(`AgentCore API error (${statusCode}): ${errorBody}${reqIdSuffix}`);
    this.name = 'AgentCoreApiError';
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.errorBody = errorBody;
  }
}

export class AgentCoreApiClient {
  private readonly region: string;
  private readonly endpoint: string;

  constructor(options: ApiClientOptions) {
    this.region = options.region;
    this.endpoint = resolveEndpoint(options.region, options.plane);
  }

  async request(options: RequestOptions): Promise<unknown> {
    const response = await this.requestRaw(options);

    if (!response.ok) {
      const errorBody = await response.text();
      const requestId = response.headers.get('x-amzn-requestid') ?? undefined;
      throw new AgentCoreApiError(response.status, errorBody, requestId);
    }

    if (response.status === 204) return {};
    return response.json();
  }

  async requestRaw(options: RequestOptions): Promise<Response> {
    const { method, path, body, query, headers: extraHeaders } = options;

    const url = new URL(path, this.endpoint);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const queryRecord: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      queryRecord[key] = value;
    });

    const serializedBody = body != null ? JSON.stringify(body) : undefined;

    const httpRequest = new HttpRequest({
      method,
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname,
      ...(Object.keys(queryRecord).length > 0 && { query: queryRecord }),
      headers: {
        'Content-Type': 'application/json',
        host: url.hostname,
        ...extraHeaders,
      },
      ...(serializedBody && { body: serializedBody }),
    });

    const credentials = getCredentialProvider() ?? defaultProvider();
    const signer = new SignatureV4({
      service: SERVICE,
      region: this.region,
      credentials,
      sha256: Sha256,
    });

    const signed = await signer.sign(httpRequest);

    const fullUrl = `${this.endpoint}${url.pathname}${url.search}`;
    return fetch(fullUrl, {
      method,
      headers: signed.headers as Record<string, string>,
      ...(serializedBody && { body: serializedBody }),
    });
  }
}

export function resolveEndpoint(region: string, plane: ApiPlane): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();

  if (plane === 'control') {
    if (stage === 'beta') return `https://beta.${region}.elcapcp.genesis-primitives.aws.dev`;
    if (stage === 'gamma') return `https://gamma.${region}.elcapcp.genesis-primitives.aws.dev`;
    return `https://bedrock-agentcore-control.${region}.${dnsSuffix(region)}`;
  }

  if (stage === 'beta') return `https://beta.${region}.elcapdp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapdp.genesis-primitives.aws.dev`;
  return `https://bedrock-agentcore.${region}.${dnsSuffix(region)}`;
}
