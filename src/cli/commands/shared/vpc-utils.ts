import { NetworkModeSchema } from '../../../schema';

export interface VpcOptions {
  networkMode?: string;
  subnets?: string;
  securityGroups?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Parse a comma-separated string into a trimmed, non-empty array.
 * Returns undefined if the input is undefined.
 */
export function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Shared VPC option validation for CLI commands.
 * Validates network mode enum, requires subnets+security groups for VPC,
 * and rejects VPC flags without VPC mode.
 */
export function validateVpcOptions(options: VpcOptions): ValidationResult {
  if (options.networkMode) {
    const nmResult = NetworkModeSchema.safeParse(options.networkMode);
    if (!nmResult.success) {
      return { valid: false, error: `Invalid network mode: ${options.networkMode}. Use PUBLIC or VPC` };
    }

    if (options.networkMode === 'VPC') {
      if (!options.subnets) {
        return { valid: false, error: '--subnets is required when --network-mode is VPC' };
      }
      if (!options.securityGroups) {
        return { valid: false, error: '--security-groups is required when --network-mode is VPC' };
      }
    }
  }

  if (options.networkMode !== 'VPC' && (options.subnets || options.securityGroups)) {
    return { valid: false, error: '--subnets and --security-groups require --network-mode VPC' };
  }

  return { valid: true };
}
