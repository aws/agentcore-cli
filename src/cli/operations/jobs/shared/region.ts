/**
 * Region resolution for jobs. Region is resolved ONCE in create() (superset precedence,
 * no regression to either legacy path) and baked into the stored ARN; refresh/stop/archive
 * parse it back out of the ARN rather than storing a separate field.
 */
import { regionFromArn } from '../../../aws/arn';
import { detectRegion } from '../../../aws/region';

// regionFromArn is shared with exec's target resolution, so it lives in cli/aws/arn.
// Re-exported here to keep the jobs-facing import path stable.
export { regionFromArn };

/** AWS targets carry a per-target region; we only need that field here. */
interface RegionTarget {
  region: string;
}

/**
 * Resolve the region for a new job, once, at create() time.
 * Precedence (superset of both legacy paths): explicit option → first deployment target → detected region.
 */
export async function resolveJobRegion(optsRegion: string | undefined, awsTargets: RegionTarget[]): Promise<string> {
  if (optsRegion) {
    return optsRegion;
  }
  if (awsTargets.length > 0 && awsTargets[0]!.region) {
    return awsTargets[0]!.region;
  }
  const { region } = await detectRegion();
  return region;
}
