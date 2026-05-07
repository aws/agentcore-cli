import { getRegion } from '../region-utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveAWSDeploymentTargets = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: function () {
    return { resolveAWSDeploymentTargets: () => mockResolveAWSDeploymentTargets() };
  },
}));

describe('getRegion', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('explicit cliRegion argument', () => {
    it('returns cliRegion immediately without consulting ConfigIO or env vars', async () => {
      process.env.AWS_DEFAULT_REGION = 'eu-central-1';
      mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'ap-southeast-1' }]);

      const result = await getRegion('us-west-2');

      expect(result).toBe('us-west-2');
      expect(mockResolveAWSDeploymentTargets).not.toHaveBeenCalled();
    });
  });

  describe('project config fallback', () => {
    it('returns first target region from project config when no cliRegion', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'ap-northeast-1' }, { region: 'us-east-1' }]);

      const result = await getRegion();

      expect(result).toBe('ap-northeast-1');
    });

    it('falls through to env vars when resolveAWSDeploymentTargets returns empty array', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([]);
      process.env.AWS_DEFAULT_REGION = 'eu-west-1';

      const result = await getRegion();

      expect(result).toBe('eu-west-1');
    });

    it('falls through to env vars when resolveAWSDeploymentTargets throws', async () => {
      mockResolveAWSDeploymentTargets.mockRejectedValue(new Error('No agentcore project found'));
      process.env.AWS_DEFAULT_REGION = 'eu-west-2';

      const result = await getRegion();

      expect(result).toBe('eu-west-2');
    });

    it('does not throw when ConfigIO constructor throws', async () => {
      mockResolveAWSDeploymentTargets.mockRejectedValue(new Error('fs error'));
      process.env.AWS_REGION = 'us-west-1';

      await expect(getRegion()).resolves.toBe('us-west-1');
    });
  });

  describe('environment variable fallback', () => {
    it('prefers AWS_DEFAULT_REGION over AWS_REGION', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([]);
      process.env.AWS_DEFAULT_REGION = 'eu-central-1';
      process.env.AWS_REGION = 'us-west-2';

      const result = await getRegion();

      expect(result).toBe('eu-central-1');
    });

    it('falls back to AWS_REGION when AWS_DEFAULT_REGION is unset', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([]);
      process.env.AWS_REGION = 'ap-south-1';

      const result = await getRegion();

      expect(result).toBe('ap-south-1');
    });

    it('returns us-east-1 when no region is configured anywhere', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([]);

      const result = await getRegion();

      expect(result).toBe('us-east-1');
    });

    it('returns us-east-1 when ConfigIO throws and no env vars are set', async () => {
      mockResolveAWSDeploymentTargets.mockRejectedValue(new Error('project not found'));

      const result = await getRegion();

      expect(result).toBe('us-east-1');
    });
  });

  describe('fallback priority order', () => {
    it('uses cliRegion > project config > AWS_DEFAULT_REGION > AWS_REGION > us-east-1', async () => {
      mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'project-region' }]);
      process.env.AWS_DEFAULT_REGION = 'env-default-region';
      process.env.AWS_REGION = 'env-region';

      expect(await getRegion('explicit-region')).toBe('explicit-region');

      expect(await getRegion(undefined)).toBe('project-region');

      mockResolveAWSDeploymentTargets.mockResolvedValue([]);
      expect(await getRegion(undefined)).toBe('env-default-region');

      delete process.env.AWS_DEFAULT_REGION;
      expect(await getRegion(undefined)).toBe('env-region');

      delete process.env.AWS_REGION;
      expect(await getRegion(undefined)).toBe('us-east-1');
    });
  });
});
