import type { DeployedProjectConfig } from '../resolve-agent';
import { resolveAgent, resolveAgentOrHarness, resolveHarness } from '../resolve-agent';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../aws/agentcore-harness', () => ({
  getHarness: vi.fn().mockResolvedValue({ harnessId: 'h-123' }),
}));

function makeContext(overrides: Partial<DeployedProjectConfig> = {}): DeployedProjectConfig {
  return {
    project: {
      name: 'test-project',
      runtimes: [{ name: 'my-agent', path: 'agents/my-agent', type: 'strands' }],
      harnesses: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      gateways: [],
      policyEngines: [],
      ...overrides.project,
    } as DeployedProjectConfig['project'],
    deployedState: {
      targets: {
        dev: {
          resources: {
            runtimes: {
              'my-agent': { runtimeId: 'rt-abc123' },
            },
          },
        },
      },
      ...overrides.deployedState,
    } as DeployedProjectConfig['deployedState'],
    awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111111111111' }],
    ...overrides,
  };
}

describe('resolveAgent', () => {
  it('resolves a single runtime', () => {
    const result = resolveAgent(makeContext(), {});
    expect(result).toEqual({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111111111111',
        runtimeId: 'rt-abc123',
      },
    });
  });

  it('returns error when no runtimes defined', () => {
    const ctx = makeContext({ project: { runtimes: [], harnesses: [] } as any });
    const result = resolveAgent(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('No runtimes defined');
  });

  it('returns error when multiple runtimes and none specified', () => {
    const ctx = makeContext({
      project: {
        runtimes: [
          { name: 'agent-a', path: 'a', type: 'strands' },
          { name: 'agent-b', path: 'b', type: 'strands' },
        ],
      } as any,
    });
    const result = resolveAgent(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Multiple runtimes');
  });

  it('resolves named runtime from multiple', () => {
    const ctx = makeContext({
      project: {
        runtimes: [
          { name: 'agent-a', path: 'a', type: 'strands' },
          { name: 'agent-b', path: 'b', type: 'strands' },
        ],
      } as any,
      deployedState: {
        targets: {
          dev: { resources: { runtimes: { 'agent-b': { runtimeId: 'rt-bbb' } } } },
        },
      } as any,
    });
    const result = resolveAgent(ctx, { runtime: 'agent-b' });
    expect(result.success).toBe(true);
    expect((result as any).agent.runtimeId).toBe('rt-bbb');
  });

  it('returns error when specified runtime not found', () => {
    const result = resolveAgent(makeContext(), { runtime: 'nonexistent' });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('not found');
  });

  it('returns error when no deployed targets', () => {
    const ctx = makeContext({ deployedState: { targets: {} } as any });
    const result = resolveAgent(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('No deployed targets');
  });

  it('returns error when runtime not deployed', () => {
    const ctx = makeContext({
      deployedState: { targets: { dev: { resources: { runtimes: {} } } } } as any,
    });
    const result = resolveAgent(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('is not deployed');
  });

  it('returns error when target config missing from aws-targets', () => {
    const ctx = makeContext();
    ctx.awsTargets = [];
    const result = resolveAgent(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('not found in aws-targets');
  });
});

describe('resolveHarness', () => {
  function harnessContext(): DeployedProjectConfig {
    return {
      project: {
        name: 'test-project',
        runtimes: [],
        harnesses: [{ name: 'my-harness', path: 'harnesses/my-harness' }],
        memories: [],
        credentials: [],
        evaluators: [],
        onlineEvalConfigs: [],
        gateways: [],
        policyEngines: [],
      } as unknown as DeployedProjectConfig['project'],
      deployedState: {
        targets: {
          dev: {
            resources: {
              harnesses: {
                'my-harness': {
                  harnessId: 'h-123',
                  agentRuntimeArn: 'arn:aws:bedrock:us-east-1:111:agent-runtime/rt-harness1',
                },
              },
            },
          },
        },
      } as any,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111111111111' }],
    };
  }

  it('resolves harness with agentRuntimeArn', async () => {
    const result = await resolveHarness(harnessContext(), 'my-harness');
    expect(result.success).toBe(true);
    expect((result as any).agent.runtimeId).toBe('rt-harness1');
  });

  it('returns error when harness not in config', async () => {
    const result = await resolveHarness(harnessContext(), 'unknown');
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('not found');
  });

  it('returns error when no harnesses defined', async () => {
    const ctx = harnessContext();
    (ctx.project as any).harnesses = [];
    const result = await resolveHarness(ctx, 'my-harness');
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('No harnesses defined');
  });

  it('returns error when harness not deployed', async () => {
    const ctx = harnessContext();
    (ctx.deployedState.targets.dev as any).resources.harnesses = {};
    const result = await resolveHarness(ctx, 'my-harness');
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('is not deployed');
  });

  it('falls back to getHarness API when no agentRuntimeArn', async () => {
    const ctx = harnessContext();
    (ctx.deployedState.targets.dev as any).resources.harnesses['my-harness'] = {
      harnessId: 'h-123',
    };
    const result = await resolveHarness(ctx, 'my-harness');
    expect(result.success).toBe(true);
    expect((result as any).agent.runtimeId).toBe('h-123');
  });
});

describe('resolveAgentOrHarness', () => {
  it('returns error when both --harness and --runtime specified', async () => {
    const result = await resolveAgentOrHarness(makeContext(), { harness: 'h', runtime: 'r' });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Cannot specify both');
  });

  it('routes to resolveHarness when --harness specified', async () => {
    const ctx: DeployedProjectConfig = {
      project: { runtimes: [], harnesses: [{ name: 'h1', path: 'h' }] } as any,
      deployedState: {
        targets: {
          dev: {
            resources: {
              harnesses: {
                h1: { harnessId: 'hid', agentRuntimeArn: 'arn:aws:bedrock:us-east-1:111:agent-runtime/rt-x' },
              },
            },
          },
        },
      } as any,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111111111111' }],
    };
    const result = await resolveAgentOrHarness(ctx, { harness: 'h1' });
    expect(result.success).toBe(true);
    expect((result as any).agent.runtimeId).toBe('rt-x');
  });

  it('auto-selects single harness when no runtimes exist', async () => {
    const ctx: DeployedProjectConfig = {
      project: { runtimes: [], harnesses: [{ name: 'solo', path: 'h' }] } as any,
      deployedState: {
        targets: {
          dev: {
            resources: {
              harnesses: {
                solo: { harnessId: 'hid', agentRuntimeArn: 'arn:aws:bedrock:us-east-1:111:agent-runtime/rt-solo' },
              },
            },
          },
        },
      } as any,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111111111111' }],
    };
    const result = await resolveAgentOrHarness(ctx, {});
    expect(result.success).toBe(true);
    expect((result as any).agent.runtimeId).toBe('rt-solo');
  });

  it('returns error when multiple harnesses and none specified', async () => {
    const ctx: DeployedProjectConfig = {
      project: {
        runtimes: [],
        harnesses: [
          { name: 'h1', path: 'a' },
          { name: 'h2', path: 'b' },
        ],
      } as any,
      deployedState: { targets: { dev: { resources: {} } } } as any,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111' }],
    };
    const result = await resolveAgentOrHarness(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Multiple harnesses');
  });

  it('returns error when no runtimes or harnesses', async () => {
    const ctx: DeployedProjectConfig = {
      project: { runtimes: [], harnesses: [] } as any,
      deployedState: { targets: {} } as any,
      awsTargets: [],
    };
    const result = await resolveAgentOrHarness(ctx, {});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('No runtimes or harnesses');
  });
});
