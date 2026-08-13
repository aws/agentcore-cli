/**
 * ARN parsing helpers.
 *
 * Kept separate from region.ts: that module *detects* the ambient region from the environment and
 * shared config files, while these are pure string functions over an ARN the caller already holds.
 */

/**
 * Parse the region out of a service ARN.
 * ARN format: arn:{partition}:{service}:{region}:{account}:{resource} → field index 3 is the region.
 * Splitting on ':' rather than matching a partition keeps this correct for GovCloud and China ARNs.
 * Returns undefined for a malformed or region-less ARN so callers can fall back.
 */
export function regionFromArn(arn: string): string | undefined {
  const region = arn.split(':')[3];
  return region && region.length > 0 ? region : undefined;
}
