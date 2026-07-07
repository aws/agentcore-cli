/**
 * Region resolution for jobs. Region is resolved ONCE in create() (superset precedence,
 * no regression to either legacy path) and baked into the stored ARN; refresh/stop/archive
 * parse it back out of the ARN rather than storing a separate field.
 */
import { detectRegion } from '../../../aws/region';

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

/**
 * Parse the region out of a service ARN.
 * ARN format: arn:{partition}:{service}:{region}:{account}:{resource} → field index 3 is the region.
 * Engine-created ARNs are always well-formed; returns undefined for a malformed/region-less ARN.
 */
export function regionFromArn(arn: string): string | undefined {
  const region = arn.split(':')[3];
  return region && region.length > 0 ? region : undefined;
}
