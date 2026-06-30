import { SECURITY_GROUP_ID_PATTERN, SUBNET_ID_PATTERN, VPC_ID_PATTERN } from '../../../schema/constants';

export interface VpcOptions {
  networkMode?: string;
  subnets?: string;
  securityGroups?: string;
  vpcId?: string;
}

export interface VpcValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Warning shown when an agent is configured with VPC network mode.
 * Used in CLI output, TUI completion screens, and exit messages.
 */
export const VPC_ENDPOINT_WARNING =
  'VPC mode may require VPC endpoints for CloudWatch, X-Ray, ECR, and Bedrock depending on your agent configuration. If your agent calls public APIs or uses an API-key-based provider, a NAT gateway or additional endpoints may also be needed.';

export function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Validate a comma-separated list of subnet IDs.
 * Returns true if valid, or an error message string if invalid.
 */
export function validateSubnetIds(value: string): true | string {
  const ids = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return 'At least one subnet ID is required';
  const invalid = ids.filter(id => !SUBNET_ID_PATTERN.test(id));
  if (invalid.length > 0) return `Invalid subnet ID format: ${invalid[0]}. Expected subnet-xxxxxxxx`;
  return true;
}

/**
 * Validate a comma-separated list of security group IDs.
 * Returns true if valid, or an error message string if invalid.
 */
export function validateSecurityGroupIds(value: string): true | string {
  const ids = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return 'At least one security group ID is required';
  const invalid = ids.filter(id => !SECURITY_GROUP_ID_PATTERN.test(id));
  if (invalid.length > 0) return `Invalid security group ID format: ${invalid[0]}. Expected sg-xxxxxxxx`;
  return true;
}

export function validateVpcId(value: string): true | string {
  if (!VPC_ID_PATTERN.test(value.trim())) {
    return `Invalid VPC ID format: ${value}. Expected vpc-xxxxxxxx`;
  }
  return true;
}

export function validateVpcOptions(options: VpcOptions, buildType?: string): VpcValidationResult {
  if (options.networkMode && options.networkMode !== 'PUBLIC' && options.networkMode !== 'VPC') {
    return { valid: false, error: `Invalid network mode: ${options.networkMode}. Use PUBLIC or VPC` };
  }

  if (options.networkMode === 'VPC') {
    if (!options.subnets) {
      return { valid: false, error: '--subnets is required when network mode is VPC' };
    }
    if (!options.securityGroups) {
      return { valid: false, error: '--security-groups is required when network mode is VPC' };
    }

    const subnetResult = validateSubnetIds(options.subnets);
    if (subnetResult !== true) return { valid: false, error: subnetResult };
    const sgResult = validateSecurityGroupIds(options.securityGroups);
    if (sgResult !== true) return { valid: false, error: sgResult };

    if (buildType === 'Container') {
      if (!options.vpcId) {
        return { valid: false, error: '--vpc-id is required for Container builds with --network-mode VPC' };
      }
      const vpcResult = validateVpcId(options.vpcId);
      if (vpcResult !== true) return { valid: false, error: vpcResult };
    }
  }

  if (options.networkMode !== 'VPC' && (options.subnets || options.securityGroups || options.vpcId)) {
    return { valid: false, error: '--subnets, --security-groups, and --vpc-id are only valid with --network-mode VPC' };
  }

  return { valid: true };
}
