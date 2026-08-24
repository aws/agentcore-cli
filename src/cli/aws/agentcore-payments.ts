/**
 * AWS client wrappers for Payment control plane operations.
 *
 * Uses direct HTTP requests with SigV4 signing against the control plane
 * because the Payment APIs are not yet in the SDK client.
 */
import { getCredentialProvider } from './account';
import { controlPlaneEndpoint, dataPlaneEndpoint } from './stage-endpoint';
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

// ── Get Payment Connector ─────────────────────────────────────────────────

export interface GetPaymentConnectorOptions {
  region: string;
  paymentManagerId: string;
  paymentConnectorId: string;
}

export type PaymentConnectorStatus =
  | 'CREATING'
  | 'UPDATING'
  | 'DELETING'
  | 'READY'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED'
  | 'AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED'
  | 'PENDING_AUTHENTICATION'
  | 'PROVISIONING'
  | 'AUTHENTICATION_EXPIRED'
  | 'AUTHENTICATION_FAILED';

export interface PaymentCredentialProviderConfiguration {
  coinbaseCDP?: { credentialProviderArn: string };
  stripePrivy?: { credentialProviderArn: string };
}

export interface PaymentConnectorDetail {
  paymentConnectorId: string;
  name: string;
  description?: string;
  type: 'CoinbaseCDP' | 'StripePrivy';
  credentialProviderConfigurations: PaymentCredentialProviderConfiguration[];
  createdAt: number | string;
  lastUpdatedAt: number | string;
  status: PaymentConnectorStatus;
  authorizationUrl?: string;
}

// ============================================================================
// HTTP signing helper
// ============================================================================

/**
 * Wrap an inner error with a contextual prefix while preserving its
 * structured `.code` (the parsed `__type` / `code` from the server response).
 */
export function rethrowWithContext(prefix: string, err: unknown): Error & { code?: string } {
  const innerMsg = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(`${prefix}: ${innerMsg}`) as Error & { code?: string };
  const innerCode = (err as { code?: unknown })?.code;
  if (typeof innerCode === 'string') wrapped.code = innerCode;
  return wrapped;
}

/**
 * Redact every literal secret value from a string, replacing occurrences with
 * `[REDACTED]`. Value-based redaction is robust to server-side reshaping
 */
export function redactSecrets(text: string, secrets: Iterable<string> | undefined): string {
  let out = text;
  for (const secret of secrets ?? []) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Build an error message excerpt from a non-2xx response body.
 *
 * - Always includes the parsed `code`/`__type` and `message` field
 *   (run through value-based redaction) so users get actionable context.
 * - With DEBUG set: appends the full (redacted) body
 */
export function sanitizeErrorBody(body: string, secrets: Iterable<string> | undefined): string {
  if (!body) return '';

  const parts: string[] = [];
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const code = parsed.code ?? parsed.__type;
    if (typeof code === 'string') parts.push(code);
    const message = parsed.message ?? parsed.Message ?? parsed.errorMessage;
    if (typeof message === 'string') parts.push(redactSecrets(message, secrets));
  } catch (_err) {
    /* body is not JSON — fall through */
  }

  if (process.env.DEBUG) {
    parts.push(redactSecrets(body, secrets).slice(0, 500));
  }

  return parts.join(' — ');
}

async function signedRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
  secretsToRedact?: Iterable<string>;
}): Promise<unknown> {
  const { region, method, path, body, secretsToRedact } = options;
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
    const errorBody = await response.text().catch(() => '');
    const baseMsg = `Payment API error (${response.status})`;
    const excerpt = sanitizeErrorBody(errorBody, secretsToRedact);
    const error = new Error(excerpt ? `${baseMsg}: ${excerpt}` : baseMsg) as Error & {
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

// ============================================================================
// Payment Credential Provider Operations
// ============================================================================

function buildProviderConfigPayload(options: CreatePaymentCredentialProviderOptions): {
  credentialProviderVendor: string;
  providerConfigurationInput: Record<string, unknown>;
  /** Literal secret values from `options`, used only for DEBUG-mode redaction. */
  secrets: string[];
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
      secrets: [options.appId, options.appSecret, options.authorizationPrivateKey, options.authorizationId],
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
    secrets: [options.apiKeyId, options.apiKeySecret, options.walletSecret],
  };
}

export async function createPaymentCredentialProvider(
  options: CreatePaymentCredentialProviderOptions
): Promise<PaymentCredentialProviderApiResult> {
  const { credentialProviderVendor, providerConfigurationInput, secrets } = buildProviderConfigPayload(options);
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
      secretsToRedact: secrets,
    })) as PaymentCredentialProviderApiResult;

    return {
      credentialProviderArn: data.credentialProviderArn,
      status: data.status,
    };
  } catch (err) {
    throw rethrowWithContext(`Failed to create payment credential provider "${options.name}"`, err);
  }
}

export async function updatePaymentCredentialProvider(
  options: UpdatePaymentCredentialProviderOptions
): Promise<PaymentCredentialProviderApiResult> {
  const { credentialProviderVendor, providerConfigurationInput, secrets } = buildProviderConfigPayload(options);
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
      secretsToRedact: secrets,
    })) as PaymentCredentialProviderApiResult;

    return {
      credentialProviderArn: data.credentialProviderArn,
      status: data.status,
    };
  } catch (err) {
    throw rethrowWithContext(`Failed to update payment credential provider "${options.name}"`, err);
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
    const code = (err as { code?: unknown }).code;
    if (code === 'ResourceNotFoundException' || msg.includes('(404)')) return null;
    throw rethrowWithContext(`Failed to get payment credential provider "${options.name}"`, err);
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
    throw rethrowWithContext(`Failed to delete payment credential provider "${options.name}"`, err);
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
    const code = (err as { code?: unknown }).code;
    if (code === 'ResourceNotFoundException' || msg.includes('(404)')) return null;
    throw rethrowWithContext(`Failed to get payment manager "${options.paymentManagerId}"`, err);
  }
}

export async function getPaymentConnector(options: GetPaymentConnectorOptions): Promise<PaymentConnectorDetail | null> {
  try {
    return (await signedRequest({
      region: options.region,
      method: 'GET',
      path:
        `/payments/managers/${encodeURIComponent(options.paymentManagerId)}/connectors/` +
        encodeURIComponent(options.paymentConnectorId),
    })) as PaymentConnectorDetail;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown }).code;
    if (code === 'ResourceNotFoundException' || msg.includes('(404)')) return null;
    throw rethrowWithContext(`Failed to get payment connector "${options.paymentConnectorId}"`, err);
  }
}

// ============================================================================
// Data Plane Operations (Payment Sessions)
// ============================================================================

async function signedDataPlaneRequest(options: {
  region: string;
  method: string;
  path: string;
  body?: string;
  extraHeaders?: Record<string, string>;
  /** See `signedRequest.secretsToRedact`. */
  secretsToRedact?: Iterable<string>;
}): Promise<unknown> {
  const { region, method, path, body, extraHeaders, secretsToRedact } = options;
  const endpoint = dataPlaneEndpoint(region);
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
    const baseMsg = `Payment data plane API error (${response.status})`;
    const excerpt = sanitizeErrorBody(errorBody, secretsToRedact);
    const error = new Error(excerpt ? `${baseMsg}: ${excerpt}` : baseMsg) as Error & {
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
