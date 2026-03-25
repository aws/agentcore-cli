import { CustomClaimValidationSchema } from '../../../schema';
import type { ValidationResult } from './validate';

const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/** Common JWT authorizer options from CLI flags. */
export interface JwtAuthorizerCliOptions {
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  customClaims?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Validate JWT authorizer options shared between Gateway and Agent CLI commands.
 * Returns a validation result; callers should check `valid` before proceeding.
 */
export function validateJwtAuthorizerOptions(options: JwtAuthorizerCliOptions): ValidationResult {
  if (!options.discoveryUrl) {
    return { valid: false, error: '--discovery-url is required for CUSTOM_JWT authorizer' };
  }

  try {
    const url = new URL(options.discoveryUrl);
    if (url.protocol !== 'https:') {
      return { valid: false, error: 'Discovery URL must use HTTPS' };
    }
  } catch {
    return { valid: false, error: 'Discovery URL must be a valid URL' };
  }

  if (!options.discoveryUrl.endsWith(OIDC_WELL_KNOWN_SUFFIX)) {
    return { valid: false, error: `Discovery URL must end with ${OIDC_WELL_KNOWN_SUFFIX}` };
  }

  // Validate custom claims JSON if provided
  if (options.customClaims) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.customClaims);
    } catch {
      return { valid: false, error: '--custom-claims must be valid JSON' };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { valid: false, error: '--custom-claims must be a non-empty JSON array' };
    }
    for (const [i, entry] of parsed.entries()) {
      const result = CustomClaimValidationSchema.safeParse(entry);
      if (!result.success) {
        return { valid: false, error: `Invalid custom claim at index ${i}: ${result.error.issues[0]?.message}` };
      }
    }
  }

  // At least one constraint must be provided
  const hasAudience = !!options.allowedAudience?.trim();
  const hasClients = !!options.allowedClients?.trim();
  const hasScopes = !!options.allowedScopes?.trim();
  const hasClaims = !!options.customClaims?.trim();
  if (!hasAudience && !hasClients && !hasScopes && !hasClaims) {
    return {
      valid: false,
      error:
        'At least one of --allowed-audience, --allowed-clients, --allowed-scopes, or --custom-claims must be provided for CUSTOM_JWT authorizer',
    };
  }

  // Client credentials must be provided as a pair
  if (options.clientId && !options.clientSecret) {
    return { valid: false, error: 'Both --client-id and --client-secret must be provided together' };
  }
  if (options.clientSecret && !options.clientId) {
    return { valid: false, error: 'Both --client-id and --client-secret must be provided together' };
  }

  return { valid: true };
}
