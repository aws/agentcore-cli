import { resolveAgentContext } from '../resolve-agent-context';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../fetch-access', () => ({
  canFetchRuntimeToken: vi.fn().mockResolvedValue(false),
  fetchRuntimeToken: vi.fn(),
}));

const mockProject = {
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [{ name: 'MyAgent', build: 'CodeZip' as const, entrypoint: 'main.py', codeLocation: 'app/MyAgent/' }],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  configBundles: [],
  datasets: [],
  policyEngines: [],
  agentCoreGateways: [],
  mcpRuntimeTools: [],
  unassignedTargets: [],
};

const mockDeployedState = {
  targets: {
    default: {
      stackName: 'TestStack',
      resources: {
        runtimes: {
          MyAgent: {
            runtimeId: 'runtime-123',
            runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/TestProject_MyAgent-abc',
          },
        },
      },
    },
  },
};

const mockTargets = [{ name: 'default', account: '123456', region: 'us-east-1' }];

describe('resolveAgentContext', () => {
  it('resolves agent context with runtimeArn and region', async () => {
    const ctx = await resolveAgentContext({
      project: mockProject as any,
      deployedState: mockDeployedState as any,
      awsTargets: mockTargets as any,
      agentName: 'MyAgent',
    });

    expect(ctx.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123456:runtime/TestProject_MyAgent-abc');
    expect(ctx.runtimeId).toBe('runtime-123');
    expect(ctx.region).toBe('us-east-1');
    expect(ctx.agentName).toBe('MyAgent');
  });

  it('auto-selects single agent when agentName is omitted', async () => {
    const ctx = await resolveAgentContext({
      project: mockProject as any,
      deployedState: mockDeployedState as any,
      awsTargets: mockTargets as any,
    });

    expect(ctx.agentName).toBe('MyAgent');
  });

  it('throws when no deployed targets', async () => {
    await expect(
      resolveAgentContext({
        project: mockProject as any,
        deployedState: { targets: {} } as any,
        awsTargets: mockTargets as any,
      })
    ).rejects.toThrow('No deployed targets');
  });

  it('throws when agent not found', async () => {
    await expect(
      resolveAgentContext({
        project: mockProject as any,
        deployedState: mockDeployedState as any,
        awsTargets: mockTargets as any,
        agentName: 'NonExistent',
      })
    ).rejects.toThrow('not found');
  });

  it('throws when agent not deployed', async () => {
    const stateWithoutRuntime = {
      targets: { default: { stackName: 'TestStack', resources: { runtimes: {} } } },
    };

    await expect(
      resolveAgentContext({
        project: mockProject as any,
        deployedState: stateWithoutRuntime as any,
        awsTargets: mockTargets as any,
        agentName: 'MyAgent',
      })
    ).rejects.toThrow('not deployed');
  });
});
