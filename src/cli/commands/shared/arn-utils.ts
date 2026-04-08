const ARN_PART_COUNT = 6;
const ARN_FORMAT = 'arn:partition:service:region:account:resource';

/**
 * Check whether a string looks like a valid ARN (starts with `arn:` and has at least 6 colon-separated parts).
 */
export function isValidArn(value: string): boolean {
  return value.startsWith('arn:') && value.split(':').length >= ARN_PART_COUNT;
}

export const ARN_VALIDATION_MESSAGE = `Must be a valid ARN (${ARN_FORMAT})`;
