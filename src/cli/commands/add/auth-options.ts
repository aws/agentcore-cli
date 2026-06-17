import { CustomClaimValidationSchema, PrivateEndpointOverrideSchema, PrivateEndpointSchema } from '../../../schema';
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
  // PrivateLink inbound (private endpoint for reaching the OIDC discovery URL).
  privateEndpointLatticeArn?: string;
  privateEndpointVpcId?: string;
  privateEndpointSubnets?: string;
  privateEndpointIpType?: string;
  privateEndpointSecurityGroups?: string;
  privateEndpointRoutingDomain?: string;
  privateEndpointTags?: string;
  privateEndpointOverrides?: string;
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

  const privateLinkResult = validatePrivateEndpointOptions(options);
  if (!privateLinkResult.valid) return privateLinkResult;

  return { valid: true };
}

/**
 * Validate PrivateLink inbound flags. The two endpoint arms (lattice / managed-vpc) are mutually
 * exclusive; managed-vpc requires --private-endpoint-subnets + --private-endpoint-ip-type. Field
 * formats and the ≤5 overrides/SG limits are checked by parsing against the Zod schemas (single
 * source of truth) so the CLI and the deploy-time validation never diverge.
 */
function validatePrivateEndpointOptions(options: JwtAuthorizerCliOptions): ValidationResult {
  const hasLattice = !!options.privateEndpointLatticeArn?.trim();
  const hasVpc = !!options.privateEndpointVpcId?.trim();

  if (hasLattice && hasVpc) {
    return {
      valid: false,
      error:
        '--private-endpoint-lattice-arn and --private-endpoint-vpc-id are mutually exclusive (a private endpoint is one of VPC Lattice or a managed VPC endpoint)',
    };
  }

  // VPC-arm sub-flags require the VPC arm.
  const vpcSubFlags = [
    options.privateEndpointSubnets,
    options.privateEndpointIpType,
    options.privateEndpointSecurityGroups,
    options.privateEndpointRoutingDomain,
    options.privateEndpointTags,
  ];
  if (!hasVpc && vpcSubFlags.some(f => f?.trim())) {
    return {
      valid: false,
      error: '--private-endpoint-* VPC flags require --private-endpoint-vpc-id',
    };
  }

  if (hasLattice) {
    const result = PrivateEndpointSchema.safeParse({
      selfManagedLatticeResource: { resourceConfigurationIdentifier: options.privateEndpointLatticeArn },
    });
    if (!result.success) {
      return { valid: false, error: `Invalid --private-endpoint-lattice-arn: ${result.error.issues[0]?.message}` };
    }
  }

  if (hasVpc) {
    if (!options.privateEndpointSubnets?.trim()) {
      return { valid: false, error: '--private-endpoint-subnets is required with --private-endpoint-vpc-id' };
    }
    if (!options.privateEndpointIpType?.trim()) {
      return {
        valid: false,
        error: '--private-endpoint-ip-type (IPV4 or IPV6) is required with --private-endpoint-vpc-id',
      };
    }
    let tags: unknown;
    if (options.privateEndpointTags) {
      try {
        tags = JSON.parse(options.privateEndpointTags);
      } catch {
        return { valid: false, error: '--private-endpoint-tags must be valid JSON' };
      }
    }
    const result = PrivateEndpointSchema.safeParse({
      managedVpcResource: {
        vpcIdentifier: options.privateEndpointVpcId,
        subnetIds: options.privateEndpointSubnets.split(',').map(s => s.trim()),
        endpointIpAddressType: options.privateEndpointIpType,
        ...(options.privateEndpointSecurityGroups && {
          securityGroupIds: options.privateEndpointSecurityGroups.split(',').map(s => s.trim()),
        }),
        ...(options.privateEndpointRoutingDomain && { routingDomain: options.privateEndpointRoutingDomain }),
        ...(tags !== undefined && { tags }),
      },
    });
    if (!result.success) {
      return { valid: false, error: `Invalid managed-VPC private endpoint: ${result.error.issues[0]?.message}` };
    }
  }

  if (options.privateEndpointOverrides) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.privateEndpointOverrides);
    } catch {
      return { valid: false, error: '--private-endpoint-overrides must be valid JSON' };
    }
    if (!Array.isArray(parsed)) {
      return { valid: false, error: '--private-endpoint-overrides must be a JSON array' };
    }
    if (parsed.length > 5) {
      return { valid: false, error: '--private-endpoint-overrides allows at most 5 entries' };
    }
    // Coupling rules (mirror the AgentCore Identity service): overrides require a base endpoint, every
    // override must use the same arm as the base, and override domains must be unique.
    if (!hasLattice && !hasVpc) {
      return {
        valid: false,
        error:
          '--private-endpoint-overrides requires a base private endpoint (--private-endpoint-lattice-arn or --private-endpoint-vpc-id)',
      };
    }
    const baseArm = hasLattice ? 'selfManagedLatticeResource' : 'managedVpcResource';
    const seenDomains = new Set<string>();
    for (const [i, entry] of parsed.entries()) {
      const result = PrivateEndpointOverrideSchema.safeParse(entry);
      if (!result.success) {
        return {
          valid: false,
          error: `Invalid private-endpoint override at index ${i}: ${result.error.issues[0]?.message}`,
        };
      }
      const overrideArm = result.data.privateEndpoint.selfManagedLatticeResource
        ? 'selfManagedLatticeResource'
        : 'managedVpcResource';
      if (overrideArm !== baseArm) {
        return {
          valid: false,
          error: `Private-endpoint override at index ${i} must be the same kind as the base endpoint (all ${baseArm === 'selfManagedLatticeResource' ? 'VPC Lattice' : 'managed VPC'})`,
        };
      }
      if (seenDomains.has(result.data.domain)) {
        return { valid: false, error: `Duplicate private-endpoint override domain: ${result.data.domain}` };
      }
      seenDomains.add(result.data.domain);
    }
  }

  return { valid: true };
}
