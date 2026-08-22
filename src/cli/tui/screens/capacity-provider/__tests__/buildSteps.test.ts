import { buildSteps } from '../AddCapacityProviderScreen';
import { describe, expect, it } from 'vitest';

describe('AddCapacityProviderScreen buildSteps', () => {
  it('always includes the base steps and lifecycle timeouts', () => {
    const steps = buildSteps(0, false);
    expect(steps).toEqual([
      'name',
      'operator-role',
      'subnets',
      'security-groups',
      'os',
      'instance-types',
      'instance-profile',
      'volumes',
      'idle-timeout',
      'max-lifetime',
      'description',
      'confirm',
    ]);
  });

  it('omits the encryption step when there are no volumes (even if encrypted is stale-true)', () => {
    const steps = buildSteps(0, true);
    expect(steps).not.toContain('volume-encryption');
    expect(steps).not.toContain('volume-kms');
  });

  it('includes the encryption step once volumes exist', () => {
    const steps = buildSteps(1, false);
    expect(steps).toContain('volume-encryption');
    expect(steps).not.toContain('volume-kms');
    // Encryption is asked right after volumes, before lifecycle timeouts.
    expect(steps.indexOf('volume-encryption')).toBe(steps.indexOf('volumes') + 1);
    expect(steps.indexOf('volume-encryption')).toBeLessThan(steps.indexOf('idle-timeout'));
  });

  it('adds the KMS-key step only when encryption is enabled with volumes present', () => {
    const steps = buildSteps(2, true);
    expect(steps).toContain('volume-encryption');
    expect(steps).toContain('volume-kms');
    // KMS immediately follows the encryption choice.
    expect(steps.indexOf('volume-kms')).toBe(steps.indexOf('volume-encryption') + 1);
  });
});
