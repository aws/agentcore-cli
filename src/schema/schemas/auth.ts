import { z } from 'zod';

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
    /** List of allowed scopes */
    allowedScopes: z.array(z.string().min(1)).optional(),
    /** Custom claim validations */
    customClaims: z.array(CustomClaimValidationSchema).min(1).optional(),
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
