import { z } from 'zod';

// ============================================================================
// Resource Connections
//
// A connection declares that a principal (an agent runtime or a harness) accesses
// an EXTERNAL AgentCore resource (a memory/gateway/runtime that is NOT part of this
// project). The construct generates the correct least-privilege IAM onto the
// principal's execution role AND injects the discovery env vars from each connection.
//
// Connections are embedded on the source resource (AgentEnvSpec.connections /
// HarnessSpec.connections); the enclosing resource IS the source, so there is no
// `from` field. In-project access remains implicit (all-to-all wiring) and is
// untouched — connections only ADD grants for external targets.
//
// FUTURE (additive, not in this milestone): targets gain an optional `name` to
// reference an in-project resource (managed reference + access gating); new target
// kinds (s3, secret) are added as union members.
// ============================================================================

/**
 * OAuth grant type for an external gateway, matching the runtime/Smithy model.
 * The harness runtime maps these to AgentCore Identity auth flows:
 *   CLIENT_CREDENTIALS -> M2M, AUTHORIZATION_CODE -> USER_FEDERATION, TOKEN_EXCHANGE -> TOKEN_EXCHANGE.
 */
export const GatewayGrantTypeSchema = z.enum(['CLIENT_CREDENTIALS', 'AUTHORIZATION_CODE', 'TOKEN_EXCHANGE']);
export type GatewayGrantType = z.infer<typeof GatewayGrantTypeSchema>;

/**
 * Outbound auth a caller uses to reach an external gateway. This is the union the
 * gateway/harness runtime actually consumes — NOT the gateway's inbound authorizerType
 * (which lives on the gateway resource and is invisible to an external caller).
 *   - awsIam: SigV4-sign with the execution role (grants InvokeGateway)
 *   - none:   no auth
 *   - oauth:  fetch an OAuth token via AgentCore Identity (grants token-fetch perms on
 *             the provider). All four oauth fields are consumed at runtime.
 */
export const GatewayOutboundAuthSchema = z.union([
  z.object({ awsIam: z.object({}).strict() }).strict(),
  z.object({ none: z.object({}).strict() }).strict(),
  z
    .object({
      oauth: z
        .object({
          providerArn: z.string().min(1),
          scopes: z.array(z.string().min(1)),
          grantType: GatewayGrantTypeSchema.optional(),
          customParameters: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type GatewayOutboundAuth = z.infer<typeof GatewayOutboundAuthSchema>;

// ---- Connection targets (external AgentCore resources, ARN-addressed) ----
// Partition-agnostic ARN prefix (arn:[^:]+:) per multi-partition rules.

const MEMORY_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:memory\/.+$/;
const GATEWAY_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:gateway\/.+$/;
const RUNTIME_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/.+$/;
// Browser / code-interpreter ARNs come in two legitimate resource-segment forms:
//   - customer-owned (CreateBrowser/CreateCodeInterpreter): `<kind>-custom/<id>` with a 12-digit account
//   - AWS-managed default (SYSTEM):                          `<kind>/<id>` with the `aws` account
export const BROWSER_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:(\d{12}|aws):browser(-custom)?\/.+$/;
export const CODE_INTERPRETER_ARN_PATTERN =
  /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:(\d{12}|aws):code-interpreter(-custom)?\/.+$/;

const MemoryTargetSchema = z
  .object({
    type: z.literal('memory'),
    arn: z.string().regex(MEMORY_ARN_PATTERN, 'Must be a valid bedrock-agentcore memory ARN'),
    /** Optional namespace templates to scope List/RetrieveMemoryRecords via the
     *  bedrock-agentcore:namespace / namespacePath condition keys. */
    namespaces: z.array(z.string().min(1)).optional(),
  })
  .strict();

const GatewayTargetSchema = z
  .object({
    type: z.literal('gateway'),
    arn: z.string().regex(GATEWAY_ARN_PATTERN, 'Must be a valid bedrock-agentcore gateway ARN'),
    /** How the caller authenticates outbound to the gateway. Defaults to awsIam (SigV4). */
    outboundAuth: GatewayOutboundAuthSchema.optional(),
  })
  .strict();

const RuntimeTargetSchema = z
  .object({
    type: z.literal('runtime'),
    arn: z.string().regex(RUNTIME_ARN_PATTERN, 'Must be a valid bedrock-agentcore runtime ARN'),
    /** Also grant InvokeAgentRuntimeCommand (container exec) in addition to invoke. */
    exec: z.boolean().optional(),
  })
  .strict();

const BrowserTargetSchema = z
  .object({
    type: z.literal('browser'),
    /** Customer-owned browser ARN. Omit to use the AWS-managed default browser. */
    arn: z.string().regex(BROWSER_ARN_PATTERN, 'Must be a valid bedrock-agentcore browser ARN').optional(),
  })
  .strict();

const CodeInterpreterTargetSchema = z
  .object({
    type: z.literal('codeInterpreter'),
    /** Customer-owned code-interpreter ARN. Omit to use the AWS-managed default. */
    arn: z
      .string()
      .regex(CODE_INTERPRETER_ARN_PATTERN, 'Must be a valid bedrock-agentcore code-interpreter ARN')
      .optional(),
  })
  .strict();

export const ConnectionTargetSchema = z.discriminatedUnion('type', [
  MemoryTargetSchema,
  GatewayTargetSchema,
  RuntimeTargetSchema,
  BrowserTargetSchema,
  CodeInterpreterTargetSchema,
]);
export type ConnectionTarget = z.infer<typeof ConnectionTargetSchema>;

/**
 * A single connection from the enclosing principal to an external resource.
 * `access` is meaningful only for memory (read | readwrite); ignored for invoke-only
 * targets. Defaults to `read` (least-privilege).
 */
export const ConnectionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, 'Connection id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}')
      .optional(),
    to: ConnectionTargetSchema,
    access: z.enum(['read', 'readwrite']).optional(),
    description: z.string().max(200).optional(),
  })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionsSchema = z.array(ConnectionSchema);

// ============================================================================
// Connection discovery env-var naming — SINGLE SOURCE OF TRUTH.
//
// The discovery env var (e.g. MEMORY_<TOKEN>_ID, GATEWAY_<TOKEN>_URL) is the handshake between the
// CLI export (which bakes the NAME into the generated agent code) and the CDK deploy (which injects
// the VALUE onto the runtime). Both sides MUST compute the identical <TOKEN>, so the token derivation
// lives here — the one file already kept in lockstep across the CLI and @aws/agentcore-cdk repos.
// `connectionEnvToken` is used by `harness-mapper` (CLI) and `connectionTokenFor` by
// `wire-connections` (CDK); do not re-implement the token derivation. Each side then assembles the
// final `<PREFIX>_<TOKEN>_<SUFFIX>` name inline (the prefixes/suffixes differ per resource kind).
// ============================================================================

/** Maximum length of a connection id (matches the ConnectionSchema id regex bound). */
export const CONNECTION_ID_MAX_LENGTH = 64;

/** Last segment of an ARN (the resource id): `memory/mem-123` -> `mem-123`. */
export function resourceIdFromArn(arn: string): string {
  const afterColon = arn.split(':').pop() ?? arn;
  const slash = afterColon.lastIndexOf('/');
  return slash >= 0 ? afterColon.slice(slash + 1) : afterColon;
}

/**
 * Stable connection id for an external target: `<kind>-<resourceId>`, sanitized to the schema id
 * charset and length. Used as the connection's `id` AND as the basis for its discovery env-var
 * token, so the name baked into generated code matches what deploy injects.
 */
export function connectionIdForTarget(target: ConnectionTarget): string {
  const suffix = 'arn' in target && target.arn ? resourceIdFromArn(target.arn) : target.type;
  const id = `${target.type}-${suffix}`;
  // Conform to ConnectionSchema id regex: start with a letter, then [a-zA-Z0-9_-], max length.
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, CONNECTION_ID_MAX_LENGTH);
}

/** Uppercase, underscore-safe token for env-var naming, derived from a connection id. */
export function connectionEnvToken(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Resolve the env-var token for a connection. Prefers the explicit `id`; otherwise derives the same
 * `<kind>-<resourceId>` id the CLI would have assigned — so an id-less connection (schema permits it,
 * e.g. a hand-authored config or a direct @aws/agentcore-cdk consumer) yields the SAME token on both
 * sides instead of diverging.
 */
export function connectionTokenFor(connection: Connection): string {
  return connectionEnvToken(connection.id ?? connectionIdForTarget(connection.to));
}
