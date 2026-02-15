import type { NodeRuntime } from '../../../schema/index.js';
import { extractNodeVersion } from '../node.js';
import { describe, expect, it } from 'vitest';

describe('extractNodeVersion', () => {
  it('extracts 18 from NODE_18', () => {
    expect(extractNodeVersion('NODE_18' as NodeRuntime)).toBe('18');
  });

  it('extracts 20 from NODE_20', () => {
    expect(extractNodeVersion('NODE_20' as NodeRuntime)).toBe('20');
  });

  it('extracts 22 from NODE_22', () => {
    expect(extractNodeVersion('NODE_22' as NodeRuntime)).toBe('22');
  });

  it('throws for unsupported runtime string', () => {
    expect(() => extractNodeVersion('PYTHON_3_12' as NodeRuntime)).toThrow('Unsupported Node runtime');
  });
});
