/**
 * Derive the AWS partition from a region string.
 */
export function getPartition(region: string): string {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}

/**
 * Return the ARN prefix (e.g. "arn:aws" or "arn:aws-us-gov") for a given region.
 */
export function arnPrefix(region: string): string {
  return `arn:${getPartition(region)}`;
}
