import { CDK_TOOLKIT_STACK_NAME, formatCdkEnvironment } from '../bootstrap.js';
import { describe, expect, it } from 'vitest';

describe('formatCdkEnvironment', () => {
  it('formats account and region into CDK environment string', () => {
    expect(formatCdkEnvironment('123456789012', 'us-east-1')).toBe('aws://123456789012/us-east-1');
  });

  it('works with different regions', () => {
    expect(formatCdkEnvironment('111222333444', 'eu-west-1')).toBe('aws://111222333444/eu-west-1');
  });
});

describe('CDK_TOOLKIT_STACK_NAME', () => {
  it('is CDKToolkit', () => {
    expect(CDK_TOOLKIT_STACK_NAME).toBe('CDKToolkit');
  });
});
