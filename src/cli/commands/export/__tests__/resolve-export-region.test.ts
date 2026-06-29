import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control what the deployment-targets read returns per test. handleExportHarness pulls in a lot of
// modules, but resolveExportRegion only needs ConfigIO.readAWSDeploymentTargets — mock the lib
// barrel so the rest of the real module loads unchanged.
const mockReadTargets = vi.fn<() => Promise<{ region: string }[]>>();

vi.mock('../../../../lib', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../lib')>();
  return {
    ...actual,
    ConfigIO: class {
      readAWSDeploymentTargets = mockReadTargets;
    },
  };
});

// Imported after the mock is registered.
const { resolveExportRegion } = await import('../harness-action');

const ARN_US_WEST_2 = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/MyHarness-abc123';
const ARN_NO_REGION = 'arn:aws:bedrock-agentcore::111122223333:harness/MyHarness-abc123';

describe('resolveExportRegion', () => {
  beforeEach(() => {
    mockReadTargets.mockReset();
    mockReadTargets.mockResolvedValue([]);
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  it('prefers the region embedded in the ARN over targets and env', async () => {
    mockReadTargets.mockResolvedValue([{ region: 'eu-central-1' }]);
    process.env.AWS_REGION = 'ap-south-1';
    await expect(resolveExportRegion(ARN_US_WEST_2)).resolves.toBe('us-west-2');
    // ARN had a region, so targets are never consulted.
    expect(mockReadTargets).not.toHaveBeenCalled();
  });

  it('falls back to the first deployment target when the ARN has no region', async () => {
    mockReadTargets.mockResolvedValue([{ region: 'eu-central-1' }]);
    await expect(resolveExportRegion(ARN_NO_REGION)).resolves.toBe('eu-central-1');
  });

  it('falls back to AWS_REGION when the ARN and targets yield nothing', async () => {
    mockReadTargets.mockResolvedValue([]);
    process.env.AWS_REGION = 'us-east-2';
    await expect(resolveExportRegion(ARN_NO_REGION)).resolves.toBe('us-east-2');
  });

  it('falls back to AWS_DEFAULT_REGION when AWS_REGION is unset', async () => {
    mockReadTargets.mockResolvedValue([]);
    process.env.AWS_DEFAULT_REGION = 'us-west-1';
    await expect(resolveExportRegion(ARN_NO_REGION)).resolves.toBe('us-west-1');
  });

  it('still resolves via env when reading targets throws', async () => {
    mockReadTargets.mockRejectedValue(new Error('no project'));
    process.env.AWS_REGION = 'ca-central-1';
    await expect(resolveExportRegion(ARN_NO_REGION)).resolves.toBe('ca-central-1');
  });

  it('returns undefined when no source yields a region', async () => {
    mockReadTargets.mockResolvedValue([]);
    await expect(resolveExportRegion(ARN_NO_REGION)).resolves.toBeUndefined();
  });
});
