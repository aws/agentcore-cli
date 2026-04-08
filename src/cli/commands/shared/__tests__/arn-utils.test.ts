import { isValidArn } from '../arn-utils';
import { describe, expect, it } from 'vitest';

describe('isValidArn', () => {
  it('accepts a valid Kinesis stream ARN', () => {
    expect(isValidArn('arn:aws:kinesis:us-west-2:123456789012:stream/my-stream')).toBe(true);
  });

  it('accepts a valid Lambda ARN', () => {
    expect(isValidArn('arn:aws:lambda:us-east-1:123456789012:function:my-func')).toBe(true);
  });

  it('rejects a string that does not start with arn:', () => {
    expect(isValidArn('not-an-arn')).toBe(false);
  });

  it('rejects an ARN with too few parts', () => {
    expect(isValidArn('arn:aws:kinesis:us-west-2:123456789012')).toBe(false);
  });

  it('accepts an ARN with colons in the resource part', () => {
    expect(isValidArn('arn:aws:kinesis:us-west-2:123456789012:stream:extra:parts')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidArn('')).toBe(false);
  });
});
