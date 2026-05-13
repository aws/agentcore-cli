import { handleLogsEval } from '../logs-eval.js';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadDeployedProjectConfig = vi.fn();
const mockResolveAgent = vi.fn();
const mockGetOnlineEvaluationConfig = vi.fn();
const mockSearchLogs = vi.fn();
const mockStreamLogs = vi.fn();

vi.mock('../../resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadDeployedProjectConfig(),
  resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  getOnlineEvaluationConfig: (...args: unknown[]) => mockGetOnlineEvaluationConfig(...args),
}));

vi.mock('../../../aws/cloudwatch', () => ({
  searchLogs: (...args: unknown[]) => mockSearchLogs(...args),
  streamLogs: (...args: unknown[]) => mockStreamLogs(...args),
}));

vi.mock('../../../../lib/utils', () => ({
  parseTimeString: (s: string) => (s === '1h' ? Date.now() - 3_600_000 : Date.now()),
}));

function makeContext({
  agentName = 'my-agent',
  onlineEvalConfigs = [{ name: 'eval-config' }] as { name: string }[],
  deployedConfigId = 'cfg-123',
} = {}) {
  return {
    project: {
      runtimes: [{ name: agentName }],
      onlineEvalConfigs,
    },
    awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111222333444' }],
    deployedState: {
      targets: {
        dev: {
          resources: {
            runtimes: {
              [agentName]: {
                runtimeId: 'rt-123',
                runtimeArn: `arn:aws:bedrock:us-east-1:111222333444:agent-runtime/rt-123`,
                roleArn: 'arn:aws:iam::111222333444:role/test',
              },
            },
            onlineEvalConfigs: deployedConfigId
              ? {
                  'eval-config': {
                    onlineEvaluationConfigId: deployedConfigId,
                    onlineEvaluationConfigArn: `arn:aws:bedrock:us-east-1:111222333444:online-evaluation-config/${deployedConfigId}`,
                  },
                }
              : {},
          },
        },
      },
    },
  };
}

function makeResolvedAgent(agentName = 'my-agent') {
  return {
    success: true as const,
    agent: {
      agentName,
      targetName: 'dev',
      region: 'us-east-1',
      accountId: '111222333444',
      runtimeId: 'rt-123',
    },
  };
}

describe('handleLogsEval', () => {
  beforeEach(() => {
    // Default: API returns the convention-based log group name
    mockGetOnlineEvaluationConfig.mockImplementation((opts: { configId: string }) =>
      Promise.resolve({
        configId: opts.configId,
        configName: 'eval-config',
        status: 'ACTIVE',
        executionStatus: 'ENABLED',
        outputLogGroupName: `/aws/bedrock-agentcore/evaluations/results/${opts.configId}`,
      })
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns error when agent resolution fails', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({});
    mockResolveAgent.mockReturnValue({ success: false, error: 'No agents defined' });

    const result = await handleLogsEval({});

    assert(!result.success);
    expect(result.error.message).toBe('No agents defined');
  });

  it('returns error when no online eval configs exist for the agent', async () => {
    const ctx = makeContext({ onlineEvalConfigs: [] });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    const result = await handleLogsEval({});

    assert(!result.success);
    expect(result.error.message).toContain('No deployed online eval configs found');
  });

  it('returns error when online eval configs exist but none are deployed', async () => {
    const ctx = makeContext({ deployedConfigId: '' });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    const result = await handleLogsEval({});

    assert(!result.success);
    expect(result.error.message).toContain('No deployed online eval configs found');
  });

  it('searches logs with time range when --since is specified', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    async function* emptyGenerator() {
      // no events
    }
    mockSearchLogs.mockReturnValue(emptyGenerator());

    const result = await handleLogsEval({ since: '1h' });

    expect(result.success).toBe(true);
    expect(mockSearchLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupName: '/aws/bedrock-agentcore/evaluations/results/cfg-123',
        region: 'us-east-1',
      })
    );
    expect(mockStreamLogs).not.toHaveBeenCalled();
  });

  it('streams logs by default when no time range is specified', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    async function* emptyGenerator() {
      // no events
    }
    mockStreamLogs.mockReturnValue(emptyGenerator());

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleLogsEval({});

    expect(result.success).toBe(true);
    expect(mockStreamLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupName: '/aws/bedrock-agentcore/evaluations/results/cfg-123',
        region: 'us-east-1',
      })
    );
    expect(mockSearchLogs).not.toHaveBeenCalled();
  });

  it('skips ResourceNotFoundException during search', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    // eslint-disable-next-line require-yield, @typescript-eslint/require-await
    async function* throwNotFound(): AsyncGenerator<never> {
      const err = new Error('Log group not found');
      (err as Error & { name: string }).name = 'ResourceNotFoundException';
      throw err;
    }
    mockSearchLogs.mockReturnValue(throwNotFound());

    const result = await handleLogsEval({ since: '1h' });

    expect(result.success).toBe(true);
  });

  it('resolves correct log group path from deployed config', async () => {
    const ctx = makeContext({ deployedConfigId: 'my-custom-config-id' });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    async function* emptyGenerator() {
      // no events
    }
    mockSearchLogs.mockReturnValue(emptyGenerator());

    await handleLogsEval({ since: '1h' });

    expect(mockSearchLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupName: '/aws/bedrock-agentcore/evaluations/results/my-custom-config-id',
      })
    );
  });

  it('uses log group name from API when available', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    mockGetOnlineEvaluationConfig.mockResolvedValue({
      configId: 'cfg-123',
      configName: 'eval-config',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      outputLogGroupName: '/custom/log/group/from-api',
    });

    async function* emptyGenerator() {
      // no events
    }
    mockSearchLogs.mockReturnValue(emptyGenerator());

    await handleLogsEval({ since: '1h' });

    expect(mockSearchLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupName: '/custom/log/group/from-api',
      })
    );
  });

  it('falls back to convention-based log group when API call fails', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    mockGetOnlineEvaluationConfig.mockRejectedValue(new Error('AccessDenied'));

    async function* emptyGenerator() {
      // no events
    }
    mockSearchLogs.mockReturnValue(emptyGenerator());

    await handleLogsEval({ since: '1h' });

    expect(mockSearchLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupName: '/aws/bedrock-agentcore/evaluations/results/cfg-123',
      })
    );
  });

  it('surfaces failure reason from config in failed state', async () => {
    const ctx = makeContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue(makeResolvedAgent());

    mockGetOnlineEvaluationConfig.mockResolvedValue({
      configId: 'cfg-123',
      configName: 'eval-config',
      status: 'CREATE_FAILED',
      executionStatus: 'DISABLED',
      failureReason: 'IAM role does not exist',
      outputLogGroupName: '/aws/bedrock-agentcore/evaluations/results/cfg-123',
    });

    async function* emptyGenerator() {
      // no events
    }
    mockSearchLogs.mockReturnValue(emptyGenerator());

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleLogsEval({ since: '1h' });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IAM role does not exist'));
  });
});
