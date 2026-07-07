import { type ConfigIO, ConfigNotFoundError } from '../../../../lib';
import { ensureDefaultDeploymentTarget } from '../ensure-target.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDetectAwsContext } = vi.hoisted(() => ({
  mockDetectAwsContext: vi.fn(),
}));

vi.mock('../../../aws', () => ({
  detectAwsContext: mockDetectAwsContext,
}));

/** Build a fake ConfigIO with stubbed read/write target methods. */
function makeConfigIO(opts: { read?: () => Promise<unknown> }): { configIO: ConfigIO; writes: unknown[] } {
  const writes: unknown[] = [];
  const configIO = {
    readAWSDeploymentTargets: opts.read ?? (() => Promise.resolve([])),
    writeAWSDeploymentTargets: (data: unknown) => {
      writes.push(data);
      return Promise.resolve();
    },
  } as unknown as ConfigIO;
  return { configIO, writes };
}

describe('ensureDefaultDeploymentTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectAwsContext.mockResolvedValue({ accountId: '123456789012', region: 'us-east-1', regionSource: 'env' });
  });

  it('writes a default target when aws-targets.json is empty', async () => {
    const { configIO, writes } = makeConfigIO({ read: () => Promise.resolve([]) });

    const wrote = await ensureDefaultDeploymentTarget(configIO);

    expect(wrote).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([{ name: 'default', account: '123456789012', region: 'us-east-1' }]);
  });

  it('does not overwrite when a target already exists', async () => {
    const existing = [{ name: 'prod', account: '999888777666', region: 'us-west-2' }];
    const { configIO, writes } = makeConfigIO({ read: () => Promise.resolve(existing) });

    const wrote = await ensureDefaultDeploymentTarget(configIO);

    expect(wrote).toBe(false);
    expect(writes).toHaveLength(0);
    expect(mockDetectAwsContext).not.toHaveBeenCalled();
  });

  it('treats a missing targets file (ConfigNotFoundError) as empty and populates it', async () => {
    const { configIO, writes } = makeConfigIO({
      read: () => Promise.reject(new ConfigNotFoundError('aws-targets.json', 'AWS Targets')),
    });

    const wrote = await ensureDefaultDeploymentTarget(configIO);

    expect(wrote).toBe(true);
    expect(writes[0]).toEqual([{ name: 'default', account: '123456789012', region: 'us-east-1' }]);
  });

  it('surfaces a non-not-found read error instead of overwriting the file', async () => {
    const { configIO, writes } = makeConfigIO({
      read: () => Promise.reject(new Error('Unexpected end of JSON input')),
    });

    await expect(ensureDefaultDeploymentTarget(configIO)).rejects.toThrow('Unexpected end of JSON input');
    expect(writes).toHaveLength(0);
  });

  it('does not write when the AWS account cannot be detected', async () => {
    mockDetectAwsContext.mockResolvedValue({ accountId: null, region: 'us-east-1', regionSource: 'default' });
    const { configIO, writes } = makeConfigIO({ read: () => Promise.resolve([]) });

    const wrote = await ensureDefaultDeploymentTarget(configIO);

    expect(wrote).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('uses the detected region for the default target', async () => {
    mockDetectAwsContext.mockResolvedValue({ accountId: '123456789012', region: 'eu-west-1', regionSource: 'config' });
    const { configIO, writes } = makeConfigIO({ read: () => Promise.resolve([]) });

    await ensureDefaultDeploymentTarget(configIO);

    expect(writes[0]).toEqual([{ name: 'default', account: '123456789012', region: 'eu-west-1' }]);
  });
});
