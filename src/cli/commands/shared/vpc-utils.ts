import { SECURITY_GROUP_ID_PATTERN, SUBNET_ID_PATTERN, VPC_ID_PATTERN } from '../../../schema/constants';
import { getCredentialProvider } from '../../aws/account';
import { DescribeSubnetsCommand, EC2Client } from '@aws-sdk/client-ec2';

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

/**
 * Resolve the VPC ID that a set of subnets belongs to, via ec2:DescribeSubnets.
 *
 * All subnets in a build's network config must live in one VPC (CodeBuild and Lambda both require
 * it), so this asserts they resolve to a single VpcId rather than blindly trusting the first result
 * — DescribeSubnets does not guarantee response order matches the request, and a wrong vpcId would
 * silently misconfigure the build. Throws a clear error naming ec2:DescribeSubnets on failure.
 */
export async function resolveVpcIdFromSubnets(subnetIds: string[], region: string): Promise<string> {
  const ec2 = new EC2Client({ region, credentials: getCredentialProvider() });
  let subnets: { SubnetId?: string; VpcId?: string }[];
  try {
    const resp = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }));
    subnets = resp.Subnets ?? [];
  } catch (err) {
    throw new Error(
      `Failed to resolve VPC ID from subnets [${subnetIds.join(', ')}]: ec2:DescribeSubnets permission is required. Cause: ${(err as Error).message ?? String(err)}`
    );
  }

  const vpcIds = new Set(subnets.map(s => s.VpcId).filter((v): v is string => !!v));
  if (vpcIds.size === 0) {
    throw new Error(
      `ec2:DescribeSubnets returned no VPC ID for subnets [${subnetIds.join(', ')}]. Verify the subnets exist and ec2:DescribeSubnets permission is granted.`
    );
  }
  if (vpcIds.size > 1) {
    throw new Error(
      `Subnets [${subnetIds.join(', ')}] span multiple VPCs (${[...vpcIds].join(', ')}). ` +
        `All subnets for a container build must be in the same VPC.`
    );
  }
  return [...vpcIds][0]!;
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
