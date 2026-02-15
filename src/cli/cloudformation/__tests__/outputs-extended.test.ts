import { buildDeployedState, parseAgentOutputs } from '../outputs.js';
import type { StackOutputs } from '../outputs.js';
import { describe, expect, it } from 'vitest';

describe('parseAgentOutputs', () => {
  describe('single agent parsing', () => {
    it('parses required agent outputs (runtimeId, runtimeArn, roleArn)', () => {
      const outputs: StackOutputs = {
        ApplicationAgentMyAgentRuntimeIdOutputABC123: 'rt-12345',
        ApplicationAgentMyAgentRuntimeArnOutputDEF456: 'arn:aws:bedrock:us-east-1:123:agent-runtime/rt-12345',
        ApplicationAgentMyAgentRoleArnOutputGHI789: 'arn:aws:iam::123:role/MyAgentRole',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(result.MyAgent).toBeDefined();
      expect(result.MyAgent!.runtimeId).toBe('rt-12345');
      expect(result.MyAgent!.runtimeArn).toBe('arn:aws:bedrock:us-east-1:123:agent-runtime/rt-12345');
      expect(result.MyAgent!.roleArn).toBe('arn:aws:iam::123:role/MyAgentRole');
    });

    it('parses optional memoryIds output (comma-separated)', () => {
      const outputs: StackOutputs = {
        ApplicationAgentMyAgentRuntimeIdOutputABC: 'rt-1',
        ApplicationAgentMyAgentRuntimeArnOutputDEF: 'arn:rt-1',
        ApplicationAgentMyAgentRoleArnOutputGHI: 'arn:role',
        ApplicationAgentMyAgentMemoryIdsOutputJKL: 'mem-1,mem-2,mem-3',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(result.MyAgent!.memoryIds).toEqual(['mem-1', 'mem-2', 'mem-3']);
    });

    it('parses optional browserId output', () => {
      const outputs: StackOutputs = {
        ApplicationAgentMyAgentRuntimeIdOutputA: 'rt-1',
        ApplicationAgentMyAgentRuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentMyAgentRoleArnOutputC: 'arn:role',
        ApplicationAgentMyAgentBrowserIdOutputD: 'browser-abc',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(result.MyAgent!.browserId).toBe('browser-abc');
    });

    it('parses optional codeInterpreterId output', () => {
      const outputs: StackOutputs = {
        ApplicationAgentMyAgentRuntimeIdOutputA: 'rt-1',
        ApplicationAgentMyAgentRuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentMyAgentRoleArnOutputC: 'arn:role',
        ApplicationAgentMyAgentCodeInterpreterIdOutputD: 'ci-xyz',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(result.MyAgent!.codeInterpreterId).toBe('ci-xyz');
    });
  });

  describe('multiple agents', () => {
    it('parses outputs for multiple agents', () => {
      const outputs: StackOutputs = {
        ApplicationAgentAgent1RuntimeIdOutputA: 'rt-1',
        ApplicationAgentAgent1RuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentAgent1RoleArnOutputC: 'arn:role-1',
        ApplicationAgentAgent2RuntimeIdOutputD: 'rt-2',
        ApplicationAgentAgent2RuntimeArnOutputE: 'arn:rt-2',
        ApplicationAgentAgent2RoleArnOutputF: 'arn:role-2',
      };

      const result = parseAgentOutputs(outputs, ['Agent1', 'Agent2'], 'TestStack');
      expect(Object.keys(result)).toHaveLength(2);
      expect(result.Agent1!.runtimeId).toBe('rt-1');
      expect(result.Agent2!.runtimeId).toBe('rt-2');
    });
  });

  describe('PascalCase agent name handling', () => {
    it('maps PascalCase output keys back to original agent names', () => {
      // Agent name "my_agent" becomes "MyAgent" in PascalCase logical IDs
      const outputs: StackOutputs = {
        ApplicationAgentMyAgentRuntimeIdOutputA: 'rt-1',
        ApplicationAgentMyAgentRuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentMyAgentRoleArnOutputC: 'arn:role',
      };

      const result = parseAgentOutputs(outputs, ['my_agent'], 'TestStack');
      // Should map back to original name
      expect(result.my_agent).toBeDefined();
      expect(result.my_agent!.runtimeId).toBe('rt-1');
    });
  });

  describe('incomplete agent outputs', () => {
    it('skips agents with missing required fields', () => {
      const outputs: StackOutputs = {
        // Agent1 has all required fields
        ApplicationAgentAgent1RuntimeIdOutputA: 'rt-1',
        ApplicationAgentAgent1RuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentAgent1RoleArnOutputC: 'arn:role-1',
        // Agent2 is missing roleArn
        ApplicationAgentAgent2RuntimeIdOutputD: 'rt-2',
        ApplicationAgentAgent2RuntimeArnOutputE: 'arn:rt-2',
      };

      const result = parseAgentOutputs(outputs, ['Agent1', 'Agent2'], 'TestStack');
      expect(result.Agent1).toBeDefined();
      expect(result.Agent2).toBeUndefined();
    });

    it('skips agents with only runtimeId', () => {
      const outputs: StackOutputs = {
        ApplicationAgentPartialRuntimeIdOutputA: 'rt-1',
      };

      const result = parseAgentOutputs(outputs, ['Partial'], 'TestStack');
      expect(result.Partial).toBeUndefined();
    });
  });

  describe('non-agent outputs', () => {
    it('ignores outputs that do not match the agent pattern', () => {
      const outputs: StackOutputs = {
        SomeRandomOutput: 'value',
        BucketNameOutput: 'my-bucket',
        ApplicationAgentMyAgentRuntimeIdOutputA: 'rt-1',
        ApplicationAgentMyAgentRuntimeArnOutputB: 'arn:rt-1',
        ApplicationAgentMyAgentRoleArnOutputC: 'arn:role',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(Object.keys(result)).toHaveLength(1);
      expect(result.MyAgent).toBeDefined();
    });

    it('returns empty object for no matching outputs', () => {
      const outputs: StackOutputs = {
        UnrelatedOutput: 'value',
      };

      const result = parseAgentOutputs(outputs, ['MyAgent'], 'TestStack');
      expect(result).toEqual({});
    });

    it('returns empty object for empty outputs', () => {
      const result = parseAgentOutputs({}, ['MyAgent'], 'TestStack');
      expect(result).toEqual({});
    });
  });
});

describe('buildDeployedState', () => {
  it('builds state for a single target', () => {
    const agents = {
      MyAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:rt-123',
        roleArn: 'arn:role',
      },
    };

    const state = buildDeployedState('default', 'MyStack', agents);
    expect(state.targets.default).toBeDefined();
    expect(state.targets.default!.resources?.agents).toEqual(agents);
    expect(state.targets.default!.resources?.stackName).toBe('MyStack');
  });

  it('merges with existing state for different targets', () => {
    const existing = {
      targets: {
        prod: {
          resources: {
            agents: {
              ProdAgent: { runtimeId: 'rt-p', runtimeArn: 'arn:rt-p', roleArn: 'arn:role-p' },
            },
            stackName: 'ProdStack',
          },
        },
      },
    };

    const devAgents = {
      DevAgent: { runtimeId: 'rt-d', runtimeArn: 'arn:rt-d', roleArn: 'arn:role-d' },
    };

    const state = buildDeployedState('dev', 'DevStack', devAgents, existing);
    expect(state.targets.prod).toBeDefined();
    expect(state.targets.dev).toBeDefined();
    expect(state.targets.prod!.resources?.stackName).toBe('ProdStack');
    expect(state.targets.dev!.resources?.stackName).toBe('DevStack');
  });

  it('overwrites existing target when same name is used', () => {
    const existing = {
      targets: {
        default: {
          resources: { agents: {}, stackName: 'OldStack' },
        },
      },
    };

    const state = buildDeployedState('default', 'NewStack', {}, existing);
    expect(state.targets.default!.resources?.stackName).toBe('NewStack');
  });

  it('includes identityKmsKeyArn when provided', () => {
    const state = buildDeployedState('default', 'Stack', {}, undefined, 'arn:aws:kms:key');
    expect(state.targets.default!.resources?.identityKmsKeyArn).toBe('arn:aws:kms:key');
  });

  it('omits identityKmsKeyArn when undefined', () => {
    const state = buildDeployedState('default', 'Stack', {});
    expect(state.targets.default!.resources?.identityKmsKeyArn).toBeUndefined();
  });

  it('handles empty agents record', () => {
    const state = buildDeployedState('default', 'Stack', {});
    expect(state.targets.default!.resources?.agents).toEqual({});
  });
});
