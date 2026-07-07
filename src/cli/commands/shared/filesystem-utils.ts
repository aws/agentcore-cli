import { EFS_ACCESS_POINT_ARN_PATTERN, S3_FILES_ACCESS_POINT_ARN_PATTERN } from '../../../schema';
import { getCredentialProvider } from '../../aws/account';
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DescribeAccessPointsCommand,
  DescribeMountTargetSecurityGroupsCommand,
  DescribeMountTargetsCommand,
  EFSClient,
} from '@aws-sdk/client-efs';
import { GetMountTargetCommand, ListMountTargetsCommand, S3FilesClient } from '@aws-sdk/client-s3files';

/** Parsed EFS or S3 Files mount entry from CLI options. */
export interface AccessPointMount {
  accessPointArn: string;
  mountPath: string;
}

/**
 * Validate an EFS access point ARN format.
 * Accepts any partition (arn:aws[-a-z]*) per multi-partition rules.
 */
export function validateEfsAccessPointArn(arn: string): true | string {
  if (!EFS_ACCESS_POINT_ARN_PATTERN.test(arn)) {
    return `Invalid EFS access point ARN: "${arn}". Expected arn:[partition]:elasticfilesystem:{region}:{account}:access-point/fsap-{id}`;
  }
  return true;
}

/**
 * Validate an S3 Files access point ARN format.
 */
export function validateS3FilesAccessPointArn(arn: string): true | string {
  if (!S3_FILES_ACCESS_POINT_ARN_PATTERN.test(arn)) {
    return `Invalid S3 Files access point ARN: "${arn}". Expected arn:[partition]:s3files:{region}:{account}:file-system/fs-{id}/access-point/fsap-{id}`;
  }
  return true;
}

/** Validate a BYO filesystem mount path (/mnt/<name>). */
export function validateBYOMountPath(path: string): true | string {
  if (path.length < 6 || path.length > 200) {
    return `Invalid mount path: "${path}". Must be between 6 and 200 characters`;
  }
  if (!/^\/mnt\/[a-zA-Z0-9._-]+\/?$/.test(path)) {
    return `Invalid mount path: "${path}". Must be /mnt/<name> with exactly one subdirectory (e.g. /mnt/tools)`;
  }
  return true;
}

/**
 * Zip ARN and mount-path arrays into AccessPointMount pairs.
 * Returns { success: false, error } when lengths differ.
 */
export function zipAccessPointPairs(
  arns: string[],
  mountPaths: string[],
  label: 'EFS' | 'S3 Files'
): { success: true; mounts: AccessPointMount[] } | { success: false; error: string } {
  if (arns.length !== mountPaths.length) {
    const arnFlag = label === 'EFS' ? '--efs-access-point-arn' : '--s3-access-point-arn';
    const pathFlag = label === 'EFS' ? '--efs-mount-path' : '--s3-mount-path';
    return {
      success: false,
      error: `${label}: ${arnFlag} and ${pathFlag} must be provided in matching pairs (got ${arns.length} ARN(s) and ${mountPaths.length} path(s))`,
    };
  }
  return {
    success: true,
    mounts: arns.map((arn, i) => ({ accessPointArn: arn, mountPath: mountPaths[i]! })),
  };
}

/**
 * Validate a full set of AccessPointMount pairs (sync format checks only).
 * Returns { success: false, error } on first failure.
 */
export function validateAccessPointMounts(
  mounts: AccessPointMount[],
  arnValidator: (arn: string) => true | string
): { success: true } | { success: false; error: string } {
  for (const { accessPointArn, mountPath } of mounts) {
    const arnResult = arnValidator(accessPointArn);
    if (arnResult !== true) return { success: false, error: arnResult };
    const pathResult = validateBYOMountPath(mountPath);
    if (pathResult !== true) return { success: false, error: pathResult };
  }
  return { success: true };
}

/**
 * Build the filesystemConfigurations spread for an AgentEnvSpec.
 * Returns `{ filesystemConfigurations: [...] }` when any mounts are present, or `{}` when none are.
 */
export function buildFilesystemConfigurations(
  sessionStorageMountPath?: string,
  efsAccessPoints?: AccessPointMount[],
  s3AccessPoints?: AccessPointMount[]
):
  | {
      filesystemConfigurations: (
        | { sessionStorage: { mountPath: string } }
        | { efsAccessPoint: AccessPointMount }
        | { s3FilesAccessPoint: AccessPointMount }
      )[];
    }
  | Record<string, never> {
  const fcs: (
    | { sessionStorage: { mountPath: string } }
    | { efsAccessPoint: AccessPointMount }
    | { s3FilesAccessPoint: AccessPointMount }
  )[] = [];
  const norm = (p: string) => p.replace(/\/$/, '');
  if (sessionStorageMountPath) fcs.push({ sessionStorage: { mountPath: norm(sessionStorageMountPath) } });
  for (const ap of efsAccessPoints ?? []) fcs.push({ efsAccessPoint: { ...ap, mountPath: norm(ap.mountPath) } });
  for (const ap of s3AccessPoints ?? []) fcs.push({ s3FilesAccessPoint: { ...ap, mountPath: norm(ap.mountPath) } });
  return fcs.length ? { filesystemConfigurations: fcs } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Validators (Level 1–3)
// ─────────────────────────────────────────────────────────────────────────────

type SyncResult = { success: true } | { success: false; error: string };

/** Resolved EFS data needed for Level 2/3 checks. */
interface EfsResolvedData {
  mountTargetId: string;
  subnetId: string;
  vpcId: string;
  availabilityZoneId?: string;
  securityGroupIds: string[];
}

/** Resolved S3 Files data needed for Level 2/3 checks. */
interface S3FilesResolvedData {
  mountTargetId: string;
  subnetId: string;
  vpcId: string;
  availabilityZoneId?: string;
  securityGroupIds: string[];
}

/**
 * Extract region from an ARN (field index 3: arn:partition:service:{region}:...).
 */
function regionFromArn(arn: string): string {
  return arn.split(':')[3]!;
}

/**
 * Extract access point ID from an EFS access point ARN.
 * The last segment after "access-point/" is the ID.
 */
function accessPointIdFromEfsArn(arn: string): string {
  return arn.split('/').pop()!;
}

/**
 * Extract mount target ID from an S3 Files access point ARN.
 * Format: .../file-system/{fsId}/access-point/{apId}
 * We need the access point ID to look up mount targets.
 */
function accessPointIdFromS3FilesArn(arn: string): string {
  return arn.split('/').pop()!;
}

/**
 * Level 1: Verify an EFS access point exists (DescribeAccessPoints).
 */
export async function validateEfsAccessPointExists(arn: string, region: string): Promise<SyncResult> {
  const client = new EFSClient({ region, credentials: getCredentialProvider() });
  const accessPointId = accessPointIdFromEfsArn(arn);
  try {
    const resp = await client.send(new DescribeAccessPointsCommand({ AccessPointId: accessPointId }));
    if (!resp.AccessPoints || resp.AccessPoints.length === 0) {
      return { success: false, error: `EFS access point not found: ${arn}` };
    }
    return { success: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { success: false, error: `EFS access point lookup failed for ${arn}: ${msg}` };
  }
}

/**
 * Level 1: Verify an S3 Files access point exists by listing mount targets.
 * Uses ListMountTargets filtered by access point ARN.
 */
export async function validateS3FilesAccessPointExists(arn: string, region: string): Promise<SyncResult> {
  const client = new S3FilesClient({ region, credentials: getCredentialProvider() });
  const accessPointId = accessPointIdFromS3FilesArn(arn);
  try {
    const resp = await client.send(new ListMountTargetsCommand({ accessPointId }));
    if (!resp.mountTargets || resp.mountTargets.length === 0) {
      return { success: false, error: `S3 Files access point has no mount targets: ${arn}` };
    }
    return { success: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { success: false, error: `S3 Files access point lookup failed for ${arn}: ${msg}` };
  }
}

/**
 * Level 1: Validate agent security groups allow egress on TCP 2049 (NFS).
 * Checks that at least one SG permits all-destination egress on port 2049 or all ports.
 */
export async function validateSecurityGroupEgressPort2049(
  securityGroupIds: string[],
  region: string
): Promise<SyncResult> {
  const ec2 = new EC2Client({ region, credentials: getCredentialProvider() });
  try {
    const resp = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: securityGroupIds }));
    for (const sg of resp.SecurityGroups ?? []) {
      for (const rule of sg.IpPermissionsEgress ?? []) {
        const proto = rule.IpProtocol;
        const fromPort = rule.FromPort ?? 0;
        const toPort = rule.ToPort ?? 65535;
        const allowsAll = proto === '-1';
        const allows2049 = (proto === 'tcp' || proto === '6') && fromPort <= 2049 && toPort >= 2049;
        const hasDestination =
          (rule.IpRanges?.some(r => r.CidrIp === '0.0.0.0/0') ?? false) ||
          (rule.Ipv6Ranges?.some(r => r.CidrIpv6 === '::/0') ?? false) ||
          (rule.UserIdGroupPairs?.length ?? 0) > 0;
        if ((allowsAll || allows2049) && hasDestination) {
          return { success: true };
        }
      }
    }
    return {
      success: false,
      error: `Agent security groups [${securityGroupIds.join(', ')}] do not allow outbound TCP 2049 (NFS). Add an egress rule for port 2049.`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { success: false, error: `Security group egress check failed: ${msg}` };
  }
}

/**
 * Resolve EFS mount target data (subnetId, vpcId, AZ, securityGroupIds) for a given access point.
 */
async function resolveEfsData(arn: string, region: string): Promise<EfsResolvedData | string> {
  const client = new EFSClient({ region, credentials: getCredentialProvider() });
  const accessPointId = accessPointIdFromEfsArn(arn);
  try {
    const mtResp = await client.send(new DescribeMountTargetsCommand({ AccessPointId: accessPointId }));
    const mt = mtResp.MountTargets?.[0];
    if (!mt?.MountTargetId || !mt.SubnetId || !mt.VpcId) {
      return `EFS access point ${arn} has no available mount targets`;
    }
    const sgResp = await client.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: mt.MountTargetId }));
    return {
      mountTargetId: mt.MountTargetId,
      subnetId: mt.SubnetId,
      vpcId: mt.VpcId,
      availabilityZoneId: mt.AvailabilityZoneId,
      securityGroupIds: sgResp.SecurityGroups ?? [],
    };
  } catch (err) {
    return `Failed to resolve EFS mount target for ${arn}: ${(err as Error).message ?? String(err)}`;
  }
}

/**
 * Resolve S3 Files mount target data for a given access point.
 * GetMountTarget returns vpcId, subnetId, securityGroups, and availabilityZoneId in one call.
 */
async function resolveS3FilesData(arn: string, region: string): Promise<S3FilesResolvedData | string> {
  const client = new S3FilesClient({ region, credentials: getCredentialProvider() });
  const accessPointId = accessPointIdFromS3FilesArn(arn);
  try {
    const listResp = await client.send(new ListMountTargetsCommand({ accessPointId }));
    const mt = listResp.mountTargets?.[0];
    if (!mt?.mountTargetId) {
      return `S3 Files access point ${arn} has no available mount targets`;
    }
    const getResp = await client.send(new GetMountTargetCommand({ mountTargetId: mt.mountTargetId }));
    if (!getResp.subnetId || !getResp.vpcId) {
      return `S3 Files mount target ${mt.mountTargetId} is missing subnet or VPC info`;
    }
    return {
      mountTargetId: mt.mountTargetId,
      subnetId: getResp.subnetId,
      vpcId: getResp.vpcId,
      availabilityZoneId: getResp.availabilityZoneId,
      securityGroupIds: getResp.securityGroups ?? [],
    };
  } catch (err) {
    return `Failed to resolve S3 Files mount target for ${arn}: ${(err as Error).message ?? String(err)}`;
  }
}

/**
 * Level 2: Validate that a mount target is in the same VPC as the agent and that
 * at least one agent subnet shares the mount target's AZ.
 */
async function validateMountTargetInVpcAndAz(
  mountData: { vpcId: string; availabilityZoneId?: string },
  agentSubnetIds: string[],
  agentVpcId: string,
  region: string,
  label: string
): Promise<SyncResult> {
  if (mountData.vpcId !== agentVpcId) {
    return {
      success: false,
      error: `${label} mount target VPC (${mountData.vpcId}) does not match agent VPC (${agentVpcId})`,
    };
  }

  if (!mountData.availabilityZoneId) return { success: true };

  const ec2 = new EC2Client({ region, credentials: getCredentialProvider() });
  try {
    const subnetResp = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: agentSubnetIds }));
    const agentAzIds = new Set((subnetResp.Subnets ?? []).map(s => s.AvailabilityZoneId).filter(Boolean));
    if (!agentAzIds.has(mountData.availabilityZoneId)) {
      return {
        success: false,
        error: `${label} mount target is in AZ ${mountData.availabilityZoneId} but no agent subnet is in that AZ. Add a subnet in AZ ${mountData.availabilityZoneId} to your agent configuration.`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Subnet AZ validation failed for ${label}: ${(err as Error).message ?? String(err)}`,
    };
  }
  return { success: true };
}

/**
 * Level 3: Validate that the mount target's security groups allow inbound TCP 2049
 * from at least one of the agent's security groups.
 */
async function validateMountTargetInboundFromAgentSg(
  mountSgIds: string[],
  agentSgIds: string[],
  region: string,
  label: string
): Promise<SyncResult> {
  if (mountSgIds.length === 0) return { success: true };

  const ec2 = new EC2Client({ region, credentials: getCredentialProvider() });
  try {
    const resp = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: mountSgIds }));
    const agentSgSet = new Set(agentSgIds);

    for (const sg of resp.SecurityGroups ?? []) {
      for (const rule of sg.IpPermissions ?? []) {
        const proto = rule.IpProtocol;
        const fromPort = rule.FromPort ?? 0;
        const toPort = rule.ToPort ?? 65535;
        const allowsAll = proto === '-1';
        const allows2049 = (proto === 'tcp' || proto === '6') && fromPort <= 2049 && toPort >= 2049;
        if (!allowsAll && !allows2049) continue;

        // Check if source includes any agent SG
        const fromAgentSg = rule.UserIdGroupPairs?.some(pair => pair.GroupId && agentSgSet.has(pair.GroupId));
        const fromAnywhere =
          (rule.IpRanges?.some(r => r.CidrIp === '0.0.0.0/0') ?? false) ||
          (rule.Ipv6Ranges?.some(r => r.CidrIpv6 === '::/0') ?? false);
        if (fromAgentSg || fromAnywhere) {
          return { success: true };
        }
      }
    }
    return {
      success: false,
      error: `${label} mount target security groups [${mountSgIds.join(', ')}] do not allow inbound TCP 2049 from agent security groups [${agentSgIds.join(', ')}]. Add an inbound rule for port 2049 from the agent SG.`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Mount target inbound SG check failed for ${label}: ${(err as Error).message ?? String(err)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI options helper
// ─────────────────────────────────────────────────────────────────────────────

export interface FilesystemCliOptions {
  efsAccessPointArn?: string[];
  efsMountPath?: string[];
  s3AccessPointArn?: string[];
  s3MountPath?: string[];
  subnets?: string;
  securityGroups?: string;
  region?: string;
}

/**
 * Zip CLI flag pairs, resolve VPC ID from subnets, and run async filesystem validation (Levels 1–3).
 * Throws on any failure. Returns resolved EFS and S3 mount arrays on success.
 */
export async function resolveAndValidateFilesystemMounts(
  options: FilesystemCliOptions,
  parseCommaSeparatedList: (val: string | undefined) => string[] | undefined
): Promise<{ efsMounts: AccessPointMount[]; s3Mounts: AccessPointMount[] }> {
  const efsPairsResult = zipAccessPointPairs(options.efsAccessPointArn ?? [], options.efsMountPath ?? [], 'EFS');
  if (!efsPairsResult.success) throw new Error(efsPairsResult.error);
  const s3PairsResult = zipAccessPointPairs(options.s3AccessPointArn ?? [], options.s3MountPath ?? [], 'S3 Files');
  if (!s3PairsResult.success) throw new Error(s3PairsResult.error);

  if (efsPairsResult.mounts.length > 0 || s3PairsResult.mounts.length > 0) {
    const awsRegion = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const subnets = parseCommaSeparatedList(options.subnets);
    const securityGroups = parseCommaSeparatedList(options.securityGroups);
    let agentVpcId: string | undefined;
    if (subnets && subnets.length > 0) {
      try {
        const ec2 = new EC2Client({ region: awsRegion, credentials: getCredentialProvider() });
        const subnetResp = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnets }));
        agentVpcId = subnetResp.Subnets?.[0]?.VpcId;
      } catch {
        // non-fatal: Level 2 topology checks are skipped when VPC ID cannot be resolved
      }
    }
    const fsValidation = await validateFilesystemMountsConfiguration({
      efsMounts: efsPairsResult.mounts,
      s3FilesMounts: s3PairsResult.mounts,
      agentVpcId,
      agentSubnetIds: subnets,
      agentSecurityGroupIds: securityGroups,
      region: awsRegion,
    });
    if (!fsValidation.success) throw new Error(fsValidation.error);
  }

  return { efsMounts: efsPairsResult.mounts, s3Mounts: s3PairsResult.mounts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export interface FilesystemValidationOptions {
  efsMounts: AccessPointMount[];
  s3FilesMounts: AccessPointMount[];
  /** Agent VPC ID (resolved from subnets). Needed for Level 2. */
  agentVpcId?: string;
  /** Agent subnet IDs. Needed for Level 2. */
  agentSubnetIds?: string[];
  /** Agent security group IDs. Needed for Level 1 egress and Level 3. */
  agentSecurityGroupIds?: string[];
  region: string;
  /** Skip Level 2 (VPC/AZ topology) checks. */
  skipTopologyChecks?: boolean;
  /** Skip Level 3 (inbound SG) checks. */
  skipInboundSgChecks?: boolean;
}

/**
 * Orchestrate full async filesystem validation (Levels 1–3).
 * Returns on first error. Each level is skipped if prerequisite data is unavailable (graceful degradation).
 *
 * L1: verify access point exists and agent SGs allow NFS egress (port 2049)
 * L2: confirm mount target shares agent's VPC and has a subnet in a matching AZ
 * L3: check mount target SGs permit inbound 2049 from agent SGs
 */
export async function validateFilesystemMountsConfiguration(opts: FilesystemValidationOptions): Promise<SyncResult> {
  const {
    efsMounts,
    s3FilesMounts,
    agentVpcId,
    agentSubnetIds,
    agentSecurityGroupIds,
    region,
    skipTopologyChecks,
    skipInboundSgChecks,
  } = opts;

  // Level 1 egress: agent SGs must allow outbound 2049
  if (agentSecurityGroupIds && agentSecurityGroupIds.length > 0 && (efsMounts.length > 0 || s3FilesMounts.length > 0)) {
    const egressResult = await validateSecurityGroupEgressPort2049(agentSecurityGroupIds, region);
    if (!egressResult.success) return egressResult;
  }

  // EFS mounts
  for (const mount of efsMounts) {
    const efsRegion = regionFromArn(mount.accessPointArn);

    // Level 1: access point exists
    const existsResult = await validateEfsAccessPointExists(mount.accessPointArn, efsRegion);
    if (!existsResult.success) return existsResult;

    if (!skipTopologyChecks && agentVpcId && agentSubnetIds) {
      const efsData = await resolveEfsData(mount.accessPointArn, efsRegion);
      if (typeof efsData === 'string') return { success: false, error: efsData };

      // Level 2: VPC + AZ
      const vpcResult = await validateMountTargetInVpcAndAz(efsData, agentSubnetIds, agentVpcId, region, 'EFS');
      if (!vpcResult.success) return vpcResult;

      // Level 3: inbound SG — mount target SGs live in the EFS region, not the agent region
      if (!skipInboundSgChecks && agentSecurityGroupIds && agentSecurityGroupIds.length > 0) {
        const sgResult = await validateMountTargetInboundFromAgentSg(
          efsData.securityGroupIds,
          agentSecurityGroupIds,
          efsRegion,
          'EFS'
        );
        if (!sgResult.success) return sgResult;
      }
    }
  }

  // S3 Files mounts
  for (const mount of s3FilesMounts) {
    const s3Region = regionFromArn(mount.accessPointArn);

    // Level 1: access point exists
    const existsResult = await validateS3FilesAccessPointExists(mount.accessPointArn, s3Region);
    if (!existsResult.success) return existsResult;

    if (!skipTopologyChecks && agentVpcId && agentSubnetIds) {
      const s3Data = await resolveS3FilesData(mount.accessPointArn, s3Region);
      if (typeof s3Data === 'string') return { success: false, error: s3Data };

      // Level 2: VPC + AZ
      const vpcResult = await validateMountTargetInVpcAndAz(s3Data, agentSubnetIds, agentVpcId, region, 'S3 Files');
      if (!vpcResult.success) return vpcResult;

      // Level 3: inbound SG — mount target SGs live in the S3 Files region, not the agent region
      if (!skipInboundSgChecks && agentSecurityGroupIds && agentSecurityGroupIds.length > 0) {
        const sgResult = await validateMountTargetInboundFromAgentSg(
          s3Data.securityGroupIds,
          agentSecurityGroupIds,
          s3Region,
          'S3 Files'
        );
        if (!sgResult.success) return sgResult;
      }
    }
  }

  return { success: true };
}
