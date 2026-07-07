import { SECURITY_GROUP_ID_PATTERN, SUBNET_ID_PATTERN, VPC_ID_PATTERN } from '../constants';
import { TagsSchema } from './primitives/tags';
import { z } from 'zod';

// Re-exported so TUI components that import *_ID_PATTERN from schemas/auth keep working.
export { SECURITY_GROUP_ID_PATTERN, SUBNET_ID_PATTERN, VPC_ID_PATTERN };

// ============================================================================
// Shared Authorization Schemas
// ============================================================================

export const GatewayAuthorizerTypeSchema = z.enum(['NONE', 'AWS_IAM', 'CUSTOM_JWT']);
export type GatewayAuthorizerType = z.infer<typeof GatewayAuthorizerTypeSchema>;

export const RuntimeAuthorizerTypeSchema = z.enum(['AWS_IAM', 'CUSTOM_JWT']);
export type RuntimeAuthorizerType = z.infer<typeof RuntimeAuthorizerTypeSchema>;

/** OIDC well-known configuration endpoint suffix (per OpenID Connect Discovery 1.0 spec) */
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/**
 * OIDC Discovery URL schema.
 * Must be a valid URL ending with the standard OIDC well-known endpoint.
 * @see https://openid.net/specs/openid-connect-discovery-1_0.html
 */
const OidcDiscoveryUrlSchema = z
  .string()
  .url('Must be a valid URL')
  .refine(url => url.startsWith('https://'), {
    message: 'OIDC discovery URL must use HTTPS',
  })
  .refine(url => url.endsWith(OIDC_WELL_KNOWN_SUFFIX), {
    message: `OIDC discovery URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`,
  });

// ── Custom Claims Schemas (matches CFN CustomClaimValidationType) ──

// API-documented patterns (from ClaimMatchValueType and CustomClaimValidationType)
const MATCH_VALUE_PATTERN = /^[A-Za-z0-9_.-]+$/;
// OAuth scope token: printable ASCII excluding space (0x20) and double-quote (0x22).
// Mirrors CFN CustomJWTAuthorizerConfiguration.AllowedScopes.items pattern byte-for-byte.
const ALLOWED_SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const CLAIM_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
// Server-side reserved claim names (not regex-documented; API rejects these at deploy time)
const RESERVED_CLAIM_NAMES = ['client_id'];

export const ClaimMatchOperatorSchema = z.enum(['EQUALS', 'CONTAINS', 'CONTAINS_ANY']);
export type ClaimMatchOperator = z.infer<typeof ClaimMatchOperatorSchema>;

export const ClaimMatchValueSchema = z
  .object({
    matchValueString: z
      .string()
      .min(1)
      .max(255)
      .regex(MATCH_VALUE_PATTERN, 'Match value must match [A-Za-z0-9_.-]+')
      .optional(),
    matchValueStringList: z
      .array(z.string().min(1).max(255).regex(MATCH_VALUE_PATTERN, 'Each match value must match [A-Za-z0-9_.-]+'))
      .min(1)
      .max(255)
      .optional(),
  })
  .refine(data => data.matchValueString !== undefined || data.matchValueStringList !== undefined, {
    message: 'Either matchValueString or matchValueStringList must be provided',
  })
  .refine(data => !(data.matchValueString !== undefined && data.matchValueStringList !== undefined), {
    message: 'Only one of matchValueString or matchValueStringList may be provided',
  });
export type ClaimMatchValue = z.infer<typeof ClaimMatchValueSchema>;

export const InboundTokenClaimValueTypeSchema = z.enum(['STRING', 'STRING_ARRAY']);
export type InboundTokenClaimValueType = z.infer<typeof InboundTokenClaimValueTypeSchema>;

export const CustomClaimValidationSchema = z
  .object({
    inboundTokenClaimName: z
      .string()
      .min(1)
      .max(255)
      .regex(CLAIM_NAME_PATTERN, 'Claim name must match [A-Za-z0-9_.-:]+')
      .refine(name => !RESERVED_CLAIM_NAMES.includes(name), {
        message: `Claim name cannot be a reserved name (${RESERVED_CLAIM_NAMES.join(', ')})`,
      }),
    inboundTokenClaimValueType: InboundTokenClaimValueTypeSchema,
    authorizingClaimMatchValue: z.object({
      claimMatchOperator: ClaimMatchOperatorSchema,
      claimMatchValue: ClaimMatchValueSchema,
    }),
  })
  .strict();
export type CustomClaimValidation = z.infer<typeof CustomClaimValidationSchema>;

// ── PrivateLink Inbound — private endpoint for reaching the OIDC discovery URL ──
//
// Nested inside CustomJWTAuthorizerConfiguration ("PrivateLink inbound" GA-parity feature):
// when a JWT IdP's discovery/JWKS endpoint is privately hosted, this tells the harness how to
// reach it over a private network. Two mutually-exclusive arms. Patterns match the
// AWS::BedrockAgentCore::Harness CFN spec byte-for-byte.

// VPC Lattice resource-config id, or its full ARN. Exported so the TUI validators reuse the
// schema regex (single source of truth) instead of hand-rolled checks that drift from it.
export const LATTICE_RESOURCE_CONFIG_PATTERN =
  /^((rcfg-[0-9a-z]{17})|(arn:[a-z0-9-]+:vpc-lattice:[a-zA-Z0-9-]+:\d{12}:resourceconfiguration\/rcfg-[0-9a-z]{17}))$/;

export const EndpointIpAddressTypeSchema = z.enum(['IPV4', 'IPV6']);
export type EndpointIpAddressType = z.infer<typeof EndpointIpAddressTypeSchema>;

/** Reach the discovery endpoint via a self-managed VPC Lattice resource configuration. */
export const SelfManagedLatticeResourceSchema = z
  .object({
    resourceConfigurationIdentifier: z
      .string()
      .min(20)
      .max(2048)
      .regex(LATTICE_RESOURCE_CONFIG_PATTERN, 'Must be a VPC Lattice resource-config id (rcfg-...) or its ARN'),
  })
  .strict();
export type SelfManagedLatticeResource = z.infer<typeof SelfManagedLatticeResourceSchema>;

/** Reach the discovery endpoint via a service-managed VPC interface endpoint. */
export const ManagedVpcResourceSchema = z
  .object({
    vpcIdentifier: z.string().regex(VPC_ID_PATTERN, 'Must be a VPC id (vpc-...)'),
    subnetIds: z.array(z.string().regex(SUBNET_ID_PATTERN, 'Must be a subnet id (subnet-...)')).min(1),
    endpointIpAddressType: EndpointIpAddressTypeSchema,
    securityGroupIds: z
      .array(z.string().regex(SECURITY_GROUP_ID_PATTERN, 'Must be a security group id (sg-...)'))
      .max(5)
      .optional(),
    tags: TagsSchema.optional(),
    routingDomain: z.string().min(3).max(255).optional(),
  })
  .strict();
export type ManagedVpcResource = z.infer<typeof ManagedVpcResourceSchema>;

/**
 * A private endpoint: exactly one of selfManagedLatticeResource or managedVpcResource.
 * The CFN spec dropped `oneOf` (contract-test antipattern) and enforces exactly-one structurally;
 * we mirror that with a superRefine rather than a discriminated union.
 */
export const PrivateEndpointSchema = z
  .object({
    selfManagedLatticeResource: SelfManagedLatticeResourceSchema.optional(),
    managedVpcResource: ManagedVpcResourceSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const count = [data.selfManagedLatticeResource, data.managedVpcResource].filter(v => v !== undefined).length;
    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A private endpoint must set exactly one of selfManagedLatticeResource or managedVpcResource',
      });
    }
  });
export type PrivateEndpoint = z.infer<typeof PrivateEndpointSchema>;

/** Maps a specific domain to its own private endpoint (overrides the discovery-URL endpoint for that domain). */
export const PrivateEndpointOverrideSchema = z
  .object({
    domain: z.string().min(1).max(253),
    privateEndpoint: PrivateEndpointSchema,
  })
  .strict();
export type PrivateEndpointOverride = z.infer<typeof PrivateEndpointOverrideSchema>;

/**
 * Which arm a PrivateEndpoint uses. The nested exactly-one-of refine guarantees a single arm,
 * so this is read at the authorizer level to enforce the service's "all endpoints same kind" rule.
 */
type PrivateEndpointArm = 'selfManagedLatticeResource' | 'managedVpcResource' | undefined;
function privateEndpointArm(pe: PrivateEndpoint): PrivateEndpointArm {
  if (pe.selfManagedLatticeResource) return 'selfManagedLatticeResource';
  if (pe.managedVpcResource) return 'managedVpcResource';
  return undefined;
}

// ── Custom JWT Authorizer Configuration ──

/**
 * Custom JWT authorizer configuration.
 * Used when authorizerType is 'CUSTOM_JWT'.
 *
 * At least one of allowedAudience, allowedClients, allowedScopes, or customClaims
 * must be provided. Only discoveryUrl is unconditionally required.
 */
export const CustomJwtAuthorizerConfigSchema = z
  .object({
    /** OIDC discovery URL (e.g., https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/openid-configuration) */
    discoveryUrl: OidcDiscoveryUrlSchema,
    /** List of allowed audiences (typically client IDs) */
    allowedAudience: z.array(z.string().min(1)).optional(),
    /** List of allowed client IDs */
    allowedClients: z.array(z.string().min(1)).optional(),
    /** List of allowed scopes (printable ASCII, no space/quote; ≤255 chars each — CFN parity) */
    allowedScopes: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(ALLOWED_SCOPE_PATTERN, 'Scope must be printable ASCII with no spaces or quotes')
      )
      .optional(),
    /** Custom claim validations */
    customClaims: z.array(CustomClaimValidationSchema).min(1).optional(),
    /** PrivateLink inbound: how to reach the OIDC discovery endpoint over a private network. */
    privateEndpoint: PrivateEndpointSchema.optional(),
    /** Per-domain private-endpoint overrides (≤5). */
    privateEndpointOverrides: z.array(PrivateEndpointOverrideSchema).max(5).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasAudience = data.allowedAudience && data.allowedAudience.length > 0;
    const hasClients = data.allowedClients && data.allowedClients.length > 0;
    const hasScopes = data.allowedScopes && data.allowedScopes.length > 0;
    const hasClaims = data.customClaims && data.customClaims.length > 0;

    if (!hasAudience && !hasClients && !hasScopes && !hasClaims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of allowedAudience, allowedClients, allowedScopes, or customClaims must be provided',
      });
    }

    // PrivateEndpointOverrides coupling rules — mirror the AgentCore Identity service's deploy-time
    // validation so the user fails fast here instead of mid-deploy.
    const overrides = data.privateEndpointOverrides ?? [];
    if (overrides.length > 0) {
      // 1. Overrides require a base privateEndpoint.
      if (!data.privateEndpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'privateEndpointOverrides can only be used when privateEndpoint is also set',
          path: ['privateEndpointOverrides'],
        });
      } else {
        // 2. The base endpoint and every override must use the same arm (all self-managed or all service-managed).
        const baseArm = privateEndpointArm(data.privateEndpoint);
        overrides.forEach((o, i) => {
          if (privateEndpointArm(o.privateEndpoint) !== baseArm) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'privateEndpoint and privateEndpointOverrides must all be the same kind — either all selfManagedLatticeResource or all managedVpcResource',
              path: ['privateEndpointOverrides', i, 'privateEndpoint'],
            });
          }
        });
      }

      // 3. Override domains must be unique.
      const seen = new Set<string>();
      overrides.forEach((o, i) => {
        if (seen.has(o.domain)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate privateEndpointOverride domain: ${o.domain}`,
            path: ['privateEndpointOverrides', i, 'domain'],
          });
        }
        seen.add(o.domain);
      });
    }
  });

export type CustomJwtAuthorizerConfig = z.infer<typeof CustomJwtAuthorizerConfigSchema>;

/**
 * Resource-agnostic authorizer configuration container.
 * Used by both Gateway and Runtime resources.
 */
export const AuthorizerConfigSchema = z.object({
  customJwtAuthorizer: CustomJwtAuthorizerConfigSchema.optional(),
});

export type AuthorizerConfig = z.infer<typeof AuthorizerConfigSchema>;

/** @deprecated Use AuthorizerConfigSchema. Backwards-compatible alias for Gateway. */
export const GatewayAuthorizerConfigSchema = AuthorizerConfigSchema;
/** @deprecated Use AuthorizerConfig. Backwards-compatible alias for Gateway. */
export type GatewayAuthorizerConfig = AuthorizerConfig;
