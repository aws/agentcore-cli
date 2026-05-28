import { canSkipDeploy, computeProjectDeployHash } from '../change-detection';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockImplementation((path: string) => {
    if (path.includes('harness.json'))
      return Promise.resolve('{"name":"h1","model":{"provider":"bedrock","modelId":"anthropic.claude-3"}}');
    if (path.includes('system-prompt.md')) return Promise.resolve('You are a helpful assistant.');
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  }),
}));

function mockConfigIO(opts: {
  runtimes?: any[];
  harnesses?: any[];
  targets?: Record<string, any>;
  awsTargets?: any[];
}) {
  return {
    readProjectSpec: vi.fn().mockResolvedValue({
      name: 'test-project',
      runtimes: opts.runtimes ?? [],
      harnesses: opts.harnesses ?? [{ name: 'h1', path: 'harnesses/h1' }],
    }),
    readDeployedState: vi.fn().mockResolvedValue({
      targets: opts.targets ?? {},
    }),
    readAWSDeploymentTargets: vi
      .fn()
      .mockResolvedValue(opts.awsTargets ?? [{ name: 'dev', region: 'us-east-1', account: '111' }]),
    getConfigRoot: vi.fn().mockReturnValue('/project/agentcore'),
  } as any;
}

describe('computeProjectDeployHash', () => {
  it('returns a 16-character hex string', async () => {
    const hash = await computeProjectDeployHash(mockConfigIO({}));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns same hash for same inputs', async () => {
    const io = mockConfigIO({});
    const hash1 = await computeProjectDeployHash(io);
    const hash2 = await computeProjectDeployHash(io);
    expect(hash1).toBe(hash2);
  });

  it('returns different hash when aws-targets change', async () => {
    const io1 = mockConfigIO({ awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111' }] });
    const io2 = mockConfigIO({ awsTargets: [{ name: 'prod', region: 'us-west-2', account: '222' }] });
    const hash1 = await computeProjectDeployHash(io1);
    const hash2 = await computeProjectDeployHash(io2);
    expect(hash1).not.toBe(hash2);
  });
});

describe('canSkipDeploy', () => {
  it('returns false when runtimes exist', async () => {
    const io = mockConfigIO({ runtimes: [{ name: 'agent', path: 'agents/a', type: 'strands' }] });
    expect(await canSkipDeploy(io)).toBe(false);
  });

  it('returns false when no targets deployed', async () => {
    const io = mockConfigIO({ targets: {} });
    expect(await canSkipDeploy(io)).toBe(false);
  });

  it('returns true when hash matches stored hash', async () => {
    const io = mockConfigIO({});
    const hash = await computeProjectDeployHash(io);
    const io2 = mockConfigIO({
      targets: { dev: { resources: { deployHash: hash } } },
    });
    expect(await canSkipDeploy(io2)).toBe(true);
  });

  it('returns false when hash differs from stored hash', async () => {
    const io = mockConfigIO({
      targets: { dev: { resources: { deployHash: 'stale0000000000' } } },
    });
    expect(await canSkipDeploy(io)).toBe(false);
  });

  it('returns false when any target has mismatched hash', async () => {
    const io = mockConfigIO({});
    const hash = await computeProjectDeployHash(io);
    const io2 = mockConfigIO({
      targets: {
        dev: { resources: { deployHash: hash } },
        prod: { resources: { deployHash: 'different0000000' } },
      },
    });
    expect(await canSkipDeploy(io2)).toBe(false);
  });

  it('returns false on error (graceful degradation)', async () => {
    const io = {
      readProjectSpec: vi.fn().mockRejectedValue(new Error('file not found')),
    } as any;
    expect(await canSkipDeploy(io)).toBe(false);
  });
});
