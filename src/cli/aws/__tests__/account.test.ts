import { AwsCredentialsError } from '../account.js';
import { describe, expect, it } from 'vitest';

describe('AwsCredentialsError', () => {
  it('uses short message as default message', () => {
    const err = new AwsCredentialsError('Short msg');
    expect(err.message).toBe('Short msg');
    expect(err.shortMessage).toBe('Short msg');
  });

  it('uses detailed message when provided', () => {
    const err = new AwsCredentialsError('Short msg', 'Detailed explanation');
    expect(err.message).toBe('Detailed explanation');
    expect(err.shortMessage).toBe('Short msg');
  });

  it('has correct name', () => {
    const err = new AwsCredentialsError('test');
    expect(err.name).toBe('AwsCredentialsError');
  });

  it('is an instance of Error', () => {
    expect(new AwsCredentialsError('test')).toBeInstanceOf(Error);
  });
});
