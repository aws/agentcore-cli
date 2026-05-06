import type { AwsDeploymentTarget } from '../../../schema';
import { applyTargetRegionToEnv, runWithTargetRegion, withTargetRegion } from '../target-region.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('target-region', () => {
  let savedRegion: string | undefined;
  let savedDefaultRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env.AWS_REGION;
    savedDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  afterEach(() => {
    if (savedRegion !== undefined) process.env.AWS_REGION = savedRegion;
    else delete process.env.AWS_REGION;
    if (savedDefaultRegion !== undefined) process.env.AWS_DEFAULT_REGION = savedDefaultRegion;
    else delete process.env.AWS_DEFAULT_REGION;
  });

  describe('applyTargetRegionToEnv', () => {
    it('sets AWS_REGION and AWS_DEFAULT_REGION to the provided region', () => {
      applyTargetRegionToEnv('ap-southeast-2');
      expect(process.env.AWS_REGION).toBe('ap-southeast-2');
      expect(process.env.AWS_DEFAULT_REGION).toBe('ap-southeast-2');
    });

    it('returns a restore function that clears env vars when they were previously unset', () => {
      const restore = applyTargetRegionToEnv('eu-west-1');
      restore();
      expect(process.env.AWS_REGION).toBeUndefined();
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });

    it('returns a restore function that restores previous env var values', () => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_DEFAULT_REGION = 'us-east-1';

      const restore = applyTargetRegionToEnv('ap-south-1');
      expect(process.env.AWS_REGION).toBe('ap-south-1');
      expect(process.env.AWS_DEFAULT_REGION).toBe('ap-south-1');

      restore();
      expect(process.env.AWS_REGION).toBe('us-east-1');
      expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
    });

    it('restores each env var independently (only one was previously set)', () => {
      process.env.AWS_REGION = 'us-west-2';
      // AWS_DEFAULT_REGION intentionally left unset

      const restore = applyTargetRegionToEnv('eu-central-1');
      expect(process.env.AWS_REGION).toBe('eu-central-1');
      expect(process.env.AWS_DEFAULT_REGION).toBe('eu-central-1');

      restore();
      expect(process.env.AWS_REGION).toBe('us-west-2');
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });
  });

  describe('withTargetRegion', () => {
    it('applies region inside the callback and restores afterwards', async () => {
      let seenRegion: string | undefined;
      let seenDefaultRegion: string | undefined;

      await withTargetRegion('ap-northeast-1', () => {
        seenRegion = process.env.AWS_REGION;
        seenDefaultRegion = process.env.AWS_DEFAULT_REGION;
        return Promise.resolve();
      });

      expect(seenRegion).toBe('ap-northeast-1');
      expect(seenDefaultRegion).toBe('ap-northeast-1');
      expect(process.env.AWS_REGION).toBeUndefined();
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });

    it('restores env vars even when the callback throws', async () => {
      process.env.AWS_REGION = 'us-east-1';

      await expect(
        withTargetRegion('sa-east-1', () => {
          expect(process.env.AWS_REGION).toBe('sa-east-1');
          return Promise.reject(new Error('boom'));
        })
      ).rejects.toThrow('boom');

      expect(process.env.AWS_REGION).toBe('us-east-1');
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });

    it('returns the callback result', async () => {
      const result = await withTargetRegion('eu-west-2', () => Promise.resolve(42));
      expect(result).toBe(42);
    });
  });

  describe('runWithTargetRegion', () => {
    const buildTarget = (region: string): AwsDeploymentTarget => ({
      name: 'default',
      account: '123456789012',
      region: region as AwsDeploymentTarget['region'],
    });

    it('applies the resolved target region inside the callback and restores afterwards', async () => {
      let seenRegion: string | undefined;
      const target = buildTarget('ap-southeast-2');

      const result = await runWithTargetRegion(
        () => Promise.resolve(target),
        resolved => {
          seenRegion = process.env.AWS_REGION;
          expect(resolved).toBe(target);
          return Promise.resolve('ok');
        }
      );

      expect(seenRegion).toBe('ap-southeast-2');
      expect(result).toBe('ok');
      expect(process.env.AWS_REGION).toBeUndefined();
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });

    it('skips the env override when no target is resolved', async () => {
      let seenRegion: string | undefined;

      await runWithTargetRegion(
        () => Promise.resolve(undefined),
        resolved => {
          seenRegion = process.env.AWS_REGION;
          expect(resolved).toBeUndefined();
          return Promise.resolve();
        }
      );

      expect(seenRegion).toBeUndefined();
      expect(process.env.AWS_REGION).toBeUndefined();
    });

    it('restores env vars even when the callback throws', async () => {
      process.env.AWS_REGION = 'us-east-1';

      await expect(
        runWithTargetRegion(
          () => Promise.resolve(buildTarget('sa-east-1')),
          () => Promise.reject(new Error('boom'))
        )
      ).rejects.toThrow('boom');

      expect(process.env.AWS_REGION).toBe('us-east-1');
    });

    it('propagates errors from the target resolver without mutating env', async () => {
      await expect(
        runWithTargetRegion(
          () => Promise.reject(new Error('cannot resolve')),
          () => Promise.resolve('unreached')
        )
      ).rejects.toThrow('cannot resolve');

      expect(process.env.AWS_REGION).toBeUndefined();
      expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    });
  });
});
