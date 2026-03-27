import { detectMode, formatLogLine, resolveAgentContext } from '../action';
import type { DeployedProjectConfig } from '../action';
import { describe, expect, it } from 'vitest';

describe('detectMode', () => {
  it('returns "stream" when no time flags', () => {
    expect(detectMode({})).toBe('stream');
  });

  it('returns "search" when --since is provided', () => {
    expect(detectMode({ since: '1h' })).toBe('search');
  });

  it('returns "search" when --until is provided', () => {
    expect(detectMode({ until: 'now' })).toBe('search');
  });

  it('returns "search" when both --since and --until are provided', () => {
    expect(detectMode({ since: '1h', until: 'now' })).toBe('search');
  });
});

describe('formatLogLine', () => {
  const event = { timestamp: 1709391000000, message: 'Hello world' };

  it('formats human-readable line with timestamp', () => {
    const line = formatLogLine(event, false);
    expect(line).toContain('Hello world');
    expect(line).toContain('2024-03-02');
  });

  it('formats JSON line', () => {
    const line = formatLogLine(event, true);
    const parsed = JSON.parse(line);
    expect(parsed.message).toBe('Hello world');
    expect(parsed.timestamp).toBeDefined();
  });
});

describe('resolveAgentContext', () => {
  // Use 'as any' to avoid branded type issues with FilePath/DirectoryPath
  const makeContext = (overrides?: Partial<DeployedProjectConfig>): DeployedProjectConfig => ({
    project: {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [
        {
          name: 'MyAgent',
          build: 'CodeZip' as const,
          entrypoint: 'main.py' as any,
          codeLocation: './agents/my-agent' as any,
          runtimeVersion: 'PYTHON_3_12' as const,
          protocol: 'HTTP' as const,
        },
      ],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
    },
    deployedState: {
      targets: {
        default: {
          resources: {
            runtimes: {
              MyAgent: {
                runtimeId: 'rt-123',
                runtimeArn: 'arn:aws:bedrock:us-east-1:123:runtime/rt-123',
                roleArn: 'arn:aws:iam::123:role/test',
              },
            },
          },
        },
      },
    },
    awsTargets: [{ name: 'default', account: '123456789012', region: 'us-east-1' as const }],
    ...overrides,
  });

  it('auto-selects single agent', () => {
    const result = resolveAgentContext(makeContext(), {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.agentContext.agentName).toBe('MyAgent');
      expect(result.agentContext.agentId).toBe('rt-123');
      expect(result.agentContext.accountId).toBe('123456789012');
      expect(result.agentContext.logGroupName).toContain('rt-123');
    }
  });

  it('errors for multiple agents without --agent flag', () => {
    const context = makeContext({
      project: {
        name: 'TestProject',
        version: 1,
        managedBy: 'CDK' as const,
        runtimes: [
          {
            name: 'AgentA',
            build: 'CodeZip' as const,
            entrypoint: 'main.py' as any,
            codeLocation: './agents/a' as any,
            runtimeVersion: 'PYTHON_3_12' as const,
            protocol: 'HTTP' as const,
          },
          {
            name: 'AgentB',
            build: 'CodeZip' as const,
            entrypoint: 'main.py' as any,
            codeLocation: './agents/b' as any,
            runtimeVersion: 'PYTHON_3_12' as const,
            protocol: 'HTTP' as const,
          },
        ],
        memories: [],
        credentials: [],
        evaluators: [],
        onlineEvalConfigs: [],
        agentCoreGateways: [],
        policyEngines: [],
      },
    });
    const result = resolveAgentContext(context, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Multiple runtimes found');
      expect(result.error).toContain('AgentA');
      expect(result.error).toContain('AgentB');
    }
  });

  it('selects correct agent with --agent flag from multiple agents', () => {
    const context = makeContext({
      project: {
        name: 'TestProject',
        version: 1,
        managedBy: 'CDK' as const,
        runtimes: [
          {
            name: 'AgentA',
            build: 'CodeZip' as const,
            entrypoint: 'main.py' as any,
            codeLocation: './agents/a' as any,
            runtimeVersion: 'PYTHON_3_12' as const,
            protocol: 'HTTP' as const,
          },
          {
            name: 'AgentB',
            build: 'CodeZip' as const,
            entrypoint: 'main.py' as any,
            codeLocation: './agents/b' as any,
            runtimeVersion: 'PYTHON_3_12' as const,
            protocol: 'HTTP' as const,
          },
        ],
        memories: [],
        credentials: [],
        evaluators: [],
        onlineEvalConfigs: [],
        agentCoreGateways: [],
        policyEngines: [],
      },
      deployedState: {
        targets: {
          default: {
            resources: {
              runtimes: {
                AgentA: {
                  runtimeId: 'rt-aaa',
                  runtimeArn: 'arn:aws:bedrock:us-east-1:123:runtime/rt-aaa',
                  roleArn: 'arn:aws:iam::123:role/test',
                },
                AgentB: {
                  runtimeId: 'rt-bbb',
                  runtimeArn: 'arn:aws:bedrock:us-east-1:123:runtime/rt-bbb',
                  roleArn: 'arn:aws:iam::123:role/test',
                },
              },
            },
          },
        },
      },
    });
    const result = resolveAgentContext(context, { runtime: 'AgentB' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.agentContext.agentName).toBe('AgentB');
      expect(result.agentContext.agentId).toBe('rt-bbb');
    }
  });

  it('errors for unknown agent name', () => {
    const result = resolveAgentContext(makeContext(), { runtime: 'UnknownAgent' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Runtime 'UnknownAgent' not found");
    }
  });

  it('errors when no agents defined', () => {
    const context = makeContext({
      project: {
        name: 'TestProject',
        version: 1,
        managedBy: 'CDK' as const,
        runtimes: [],
        memories: [],
        credentials: [],
        evaluators: [],
        onlineEvalConfigs: [],
        agentCoreGateways: [],
        policyEngines: [],
      },
    });
    const result = resolveAgentContext(context, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No runtimes defined');
    }
  });

  it('errors when agent is not deployed', () => {
    const context = makeContext({
      deployedState: {
        targets: {
          default: {
            resources: {
              runtimes: {},
            },
          },
        },
      },
    });
    const result = resolveAgentContext(context, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('is not deployed');
    }
  });
});
