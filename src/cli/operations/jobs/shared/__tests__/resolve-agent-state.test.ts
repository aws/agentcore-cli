import type { DeployedState } from '../../../../../schema';
import { resolveAgentState } from '../resolve-agent-state';
import { describe, expect, it } from 'vitest';

const runtime = (id: string) => ({
  runtimeId: id,
  runtimeArn: `arn:aws:bedrock-agentcore:::runtime/${id}`,
  roleArn: 'r',
});

describe('resolveAgentState', () => {
  const deployedState = {
    targets: {
      dev: { resources: { runtimes: { other: runtime('other-1') } } },
      prod: { resources: { runtimes: { agent: runtime('agent-1') } } },
    },
  } as unknown as DeployedState;

  it('returns the runtime with the target it was found in', () => {
    expect(resolveAgentState(deployedState, 'agent')).toEqual({ ...runtime('agent-1'), targetName: 'prod' });
  });

  it('returns undefined when the agent is not deployed', () => {
    expect(resolveAgentState(deployedState, 'missing')).toBeUndefined();
  });
});
