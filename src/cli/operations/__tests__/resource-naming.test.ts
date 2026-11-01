import type { AwsDeploymentTarget } from '../../../schema';
import {
  getPhysicalProjectName,
  getPhysicalProjectNameForTarget,
  validatePhysicalProjectName,
} from '../resource-naming';
import { describe, expect, it } from 'vitest';

const target = (overrides: Partial<AwsDeploymentTarget> = {}): AwsDeploymentTarget => ({
  name: 'dev',
  account: '123456789012',
  region: 'us-east-1',
  ...overrides,
});

describe('getPhysicalProjectName', () => {
  it('returns the plain project name without a target or suffix', () => {
    expect(getPhysicalProjectName('myapp')).toBe('myapp');
    expect(getPhysicalProjectName('myapp', target())).toBe('myapp');
  });

  it('appends the target resourceNameSuffix', () => {
    expect(getPhysicalProjectName('myapp', target({ resourceNameSuffix: 'Dev' }))).toBe('myappDev');
  });
});

describe('getPhysicalProjectNameForTarget', () => {
  const targets = [target({ resourceNameSuffix: 'Dev' }), target({ name: 'prod' })];

  it('looks the target up by name', () => {
    expect(getPhysicalProjectNameForTarget('myapp', targets, 'dev')).toBe('myappDev');
    expect(getPhysicalProjectNameForTarget('myapp', targets, 'prod')).toBe('myapp');
  });

  it('falls back to the plain project name for unknown or missing targets', () => {
    expect(getPhysicalProjectNameForTarget('myapp', targets, 'qa')).toBe('myapp');
    expect(getPhysicalProjectNameForTarget('myapp', targets, undefined)).toBe('myapp');
  });
});

describe('validatePhysicalProjectName', () => {
  it('accepts a suffixed name within the 23-char project name limit', () => {
    expect(() => validatePhysicalProjectName('a'.repeat(15), target({ resourceNameSuffix: 'Staging1' }))).not.toThrow();
  });

  it('rejects a suffixed name over 23 chars', () => {
    expect(() => validatePhysicalProjectName('a'.repeat(16), target({ resourceNameSuffix: 'Staging1' }))).toThrow(
      'Use a shorter resourceNameSuffix'
    );
  });

  it('skips targets without a suffix', () => {
    expect(() => validatePhysicalProjectName('a'.repeat(30), target())).not.toThrow();
  });
});
