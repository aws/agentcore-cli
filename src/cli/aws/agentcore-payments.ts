/**
 * AWS client wrappers for Payment control plane operations.
 *
 * Uses direct HTTP requests with SigV4 signing against the control plane
 * because the Payment APIs are not yet in the SDK client.
 */
import { getCredentialProvider } from './account';
import { serviceEndpoint } from './partition';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

// ============================================================================
// Types
// ============================================================================

// ── Create Payment Credential Provider ─────────────────────────────────────

interface CreateCoinbaseCdpCredentialProviderOptions {
  region: string;
  name: string;
  vendor: 'CoinbaseCDP';
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

interface CreateStripePrivyCredentialProviderOptions {
  region: string;
  name: string;
  vendor: 'StripePrivy';
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  authorizationId: string;
}

type CreatePaymentCredentialProviderOptions =
  | CreateCoinbaseCdpCredentialProviderOptions
  | CreateStripePrivyCredentialProviderOptions;

interface PaymentCredentialProviderApiResult {
  credentialProviderArn: string;
  status: string;
}

// ── Update Payment Credential Provider ─────────────────────────────────────

type UpdatePaymentCredentialProviderOptions = CreatePaymentCredentialProviderOptions;

// ── Get Payment Credential Provider ────────────────────────────────────────

interface GetPaymentCredentialProviderOptions {
  region: string;
  name: string;
}

interface PaymentCredentialProviderDetail {
  credentialProviderArn: string;
  name: string;
  status: string;
}

// ── Get Payment Manager ───────────────────────────────────────────────────

interface GetPaymentManagerOptions {
  region: string;
  paymentManagerId: string;
}

interface PaymentManagerDetail {
  paymentManagerId: string;
  paymentManagerArn: string;
  name: string;
  status: string;
  description?: string;
  roleArn?: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

function getControlPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapcp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapcp.genesis-primitives.aws.dev`;
  return `https://${serviceEndpoint('bedrock-agentcore-control', region)}`;
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

  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers: signedReq.headers as Record<string, string>,
      ...(body && { body }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Payment API request timed out (>8s) for ${method} ${path}. Check network connectivity and region.`
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errorBody = await response.text();
    // Sanitize error body -- API validation errors may echo request fields containing secrets
    const sanitized = errorBody
      .replace(
        /("apiKeySecret"|"walletSecret"|"apiKeyId"|"appId"|"appSecret"|"authorizationPrivateKey"|"authorizationId")\s*:\s*"[^"]*"/g,
        '$1:"[REDACTED]"'
      )
      .slice(0, 500);

    const error = new Error(`Payment API error (${response.status}): ${sanitized}`) as Error & { code?: string };
    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>;
      const code = parsed.code ?? parsed.__type;
      if (typeof code === 'string') error.code = code;
    } catch (_err) {
      /* ignore parse failures */
    }
    throw error;
  }

  if (response.status === 204) return {};
  return response.json();
}

// ============================================================================
// Payment Credential Provider Operations
// ============================================================================

function buildProviderConfigPayload(options: CreatePaymentCredentialProviderOptions): {
  credentialProviderVendor: string;
  providerConfigurationInput: Record<string, unknown>;
} {
  if (options.vendor === 'StripePrivy') {
    return {
      credentialProviderVendor: 'StripePrivy',
      providerConfigurationInput: {
        stripePrivyConfiguration: {
          appId: options.appId,
          appSecret: options.appSecret,
          authorizationPrivateKey: options.authorizationPrivateKey,
          authorizationId: options.authorizationId,
        },
      },
    };
  }
  return {
    credentialProviderVendor: 'CoinbaseCDP',
    providerConfigurationInput: {
      coinbaseCdpConfiguration: {
        apiKeyId: options.apiKeyId,
        apiKeySecret: options.apiKeySecret,
        walletSecret: options.walletSecret,
      },
    },
  };
}

export async function createPaymentCredentialProvider(
  options: CreatePaymentCredentialProviderOptions
): Promise<PaymentCredentialProviderApiResult> {
  const { credentialProviderVendor, providerConfigurationInput } = buildProviderConfigPayload(options);
  const body = JSON.stringify({
    name: options.name,
    credentialProviderVendor,
    providerConfigurationInput,
  });

  try {
    const data = (await signedRequest({
      region: options.region,
      method: 'POST',
      path: '/identities/CreatePaymentCredentialProvider',
      body,
    })) as PaymentCredentialProviderApiResult;

    return {
      credentialProviderArn: data.credentialProviderArn,
      status: data.status,
    };
  } catch (err) {
    throw new Error(
      `Failed to create payment credential provider "${options.name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function updatePaymentCredentialProvider(
  options: UpdatePaymentCredentialProviderOptions
): Promise<PaymentCredentialProviderApiResult> {
  const { credentialProviderVendor, providerConfigurationInput } = buildProviderConfigPayload(options);
  const body = JSON.stringify({
    name: options.name,
    credentialProviderVendor,
    providerConfigurationInput,
  });

  try {
    const data = (await signedRequest({
      region: options.region,
      method: 'POST',
      path: '/identities/UpdatePaymentCredentialProvider',
      body,
    })) as PaymentCredentialProviderApiResult;

    return {
      credentialProviderArn: data.credentialProviderArn,
      status: data.status,
    };
  } catch (err) {
    throw new Error(
      `Failed to update payment credential provider "${options.name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function getPaymentCredentialProvider(
  options: GetPaymentCredentialProviderOptions
): Promise<PaymentCredentialProviderDetail | null> {
  try {
    const data = (await signedRequest({
      region: options.region,
      method: 'POST',
      path: '/identities/GetPaymentCredentialProvider',
      body: JSON.stringify({ name: options.name }),
    })) as PaymentCredentialProviderDetail;

    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('(404)') || msg.includes('ResourceNotFoundException')) return null;
    throw new Error(`Failed to get payment credential provider "${options.name}": ${msg}`);
  }
}

export async function deletePaymentCredentialProvider(options: { region: string; name: string }): Promise<void> {
  try {
    await signedRequest({
      region: options.region,
      method: 'POST',
      path: '/identities/DeletePaymentCredentialProvider',
      body: JSON.stringify({ name: options.name }),
    });
  } catch (err) {
    throw new Error(
      `Failed to delete payment credential provider "${options.name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ============================================================================
// Payment Manager Operations
// ============================================================================

export async function getPaymentManager(options: GetPaymentManagerOptions): Promise<PaymentManagerDetail | null> {
  try {
    return (await signedRequest({
      region: options.region,
      method: 'GET',
      path: `/payments/managers/${encodeURIComponent(options.paymentManagerId)}`,
    })) as PaymentManagerDetail;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('(404)') || msg.includes('ResourceNotFoundException')) return null;
    throw new Error(`Failed to get payment manager "${options.paymentManagerId}": ${msg}`);
  }
}

// ============================================================================
// Data Plane Operations (Payment Sessions)
// ============================================================================

function getDataPlaneEndpoint(region: string): string {
  const stage = process.env.AGENTCORE_STAGE?.toLowerCase();
  if (stage === 'beta') return `https://beta.${region}.elcapdp.genesis-primitives.aws.dev`;
  if (stage === 'gamma') return `https://gamma.${region}.elcapdp.genesis-primitives.aws.dev`;
  return `https://${serviceEndpoint('bedrock-agentcore', region)}`;
}

async function signedDataPlaneRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
  extraHeaders?: Record<string, string>;
}): Promise<unknown> {
  const { region, method, path, body, extraHeaders } = options;
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
      ...extraHeaders,
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

  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers: signedReq.headers as Record<string, string>,
      ...(body && { body }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Payment data plane API request timed out (>8s) for ${method} ${path}. Check network connectivity and region.`
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const sanitized = errorBody
      .replace(
        /("apiKeySecret"|"walletSecret"|"apiKeyId"|"appId"|"appSecret"|"authorizationPrivateKey"|"authorizationId")\s*:\s*"[^"]*"/g,
        '$1:"[REDACTED]"'
      )
      .slice(0, 500);
    const error = new Error(`Payment data plane API error (${response.status}): ${sanitized}`) as Error & {
      code?: string;
    };
    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>;
      const code = parsed.code ?? parsed.__type;
      if (typeof code === 'string') error.code = code;
    } catch (_err) {
      /* ignore parse failures */
    }
    throw error;
  }

  if (response.status === 204) return {};
  return response.json();
}

// ── Payment Session Types ─────────────────────────────────────────────────

interface GetOrCreatePaymentSessionOptions {
  region: string;
  managerArn: string;
  userId: string;
  defaultSpendLimit?: string;
  defaultExpiryMinutes?: number;
}

interface PaymentSessionSummary {
  paymentSessionId: string;
  status: string;
  expiryTime?: string;
}

interface ListPaymentSessionsResult {
  paymentSessions: PaymentSessionSummary[];
  nextToken?: string;
}

interface CreatePaymentSessionResult {
  // CreatePaymentSession wraps the session in `paymentSession`, unlike
  // ListPaymentSessions which returns `paymentSessions[]` at the top level.
  paymentSession: {
    paymentSessionId: string;
    paymentManagerArn?: string;
    userId?: string;
    expiryTimeInMinutes?: number;
  };
}

/**
 * Get an existing active payment session or create a new one with default budget.
 * Uses the developer's credentials (ManagementRole).
 */
export async function getOrCreatePaymentSession(options: GetOrCreatePaymentSessionOptions): Promise<string> {
  const { region, managerArn, userId, defaultSpendLimit = '10.00', defaultExpiryMinutes = 60 } = options;
  const userIdHeader = { 'X-Amzn-Bedrock-AgentCore-Payments-User-Id': userId };

  // Try to find an existing active session
  try {
    const listResult = (await signedDataPlaneRequest({
      region,
      method: 'POST',
      path: '/payments/listPaymentSessions',
      body: JSON.stringify({
        userId,
        paymentManagerArn: managerArn,
      }),
      extraHeaders: userIdHeader,
    })) as ListPaymentSessionsResult;

    const activeSessions = (listResult.paymentSessions ?? []).filter(s => s.status === 'ACTIVE');
    if (activeSessions.length > 0) {
      return activeSessions[0]!.paymentSessionId;
    }
  } catch (_err) {
    // If list fails, fall through to create
  }

  // No active session found — create one with configured budget
  const createResult = (await signedDataPlaneRequest({
    region,
    method: 'POST',
    path: '/payments/createPaymentSession',
    body: JSON.stringify({
      userId,
      paymentManagerArn: managerArn,
      expiryTimeInMinutes: defaultExpiryMinutes,
      limits: {
        maxSpendAmount: {
          value: defaultSpendLimit,
          currency: 'USD',
        },
      },
    }),
    extraHeaders: userIdHeader,
  })) as CreatePaymentSessionResult;

  return createResult.paymentSession.paymentSessionId;
}
