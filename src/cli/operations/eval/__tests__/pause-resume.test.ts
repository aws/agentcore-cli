import { handlePauseResume } from '../pause-resume.js';
import assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLoadDeployedProjectConfig = vi.fn();
const mockUpdateOnlineEvalExecutionStatus = vi.fn();

vi.mock('../../resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadDeployedProjectConfig(),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  updateOnlineEvalExecutionStatus: (...args: unknown[]) => mockUpdateOnlineEvalExecutionStatus(...args),
}));

function makeContext(configName: string, configId: string, targetName = 'dev', region = 'us-east-1') {
  return {
    project: {},
    awsTargets: [{ name: targetName, region, account: '123456789012' }],
    deployedState: {
      targets: {
        [targetName]: {
          resources: {
            onlineEvalConfigs: {
              [configName]: {
                onlineEvaluationConfigId: configId,
                onlineEvaluationConfigArn: `arn:aws:bedrock:${region}:123456789012:online-evaluation-config/${configId}`,
              },
            },
          },
        },
      },
    },
  };
}

describe('handlePauseResume', () => {
  afterEach(() => vi.clearAllMocks());

  it('pauses an online eval config', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
      configId: 'cfg-123',
      executionStatus: 'DISABLED',
      status: 'ACTIVE',
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    assert(result.success);
    expect(result.executionStatus).toBe('DISABLED');
    expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'DISABLED',
    });
  });

  it('resumes an online eval config', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
      configId: 'cfg-123',
      executionStatus: 'ENABLED',
      status: 'ACTIVE',
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'resume');

    assert(result.success);
    expect(result.executionStatus).toBe('ENABLED');
    expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'ENABLED',
    });
  });

  it('returns error when no deployed targets exist', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: {},
      awsTargets: [],
      deployedState: { targets: {} },
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    assert(!result.success);
    expect(result.error.message).toContain('No deployed targets found');
  });

  it('returns error when config name is not found in deployed state', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('other-config', 'cfg-999'));

    const result = await handlePauseResume({ name: 'missing-config' }, 'pause');

    assert(!result.success);
    expect(result.error.message).toContain('missing-config');
    expect(result.error.message).toContain('not found');
  });

  it('returns error when target config is missing from aws-targets', async () => {
    const context = makeContext('my-config', 'cfg-123');
    // Remove the target from awsTargets but keep it in deployedState
    context.awsTargets = [];
    mockLoadDeployedProjectConfig.mockResolvedValue(context);

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    assert(!result.success);
    expect(result.error.message).toContain('Target config');
    expect(result.error.message).toContain('not found');
  });

  it('returns error when the SDK call fails', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockRejectedValue(new Error('Service unavailable'));

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    assert(!result.success);
    expect(result.error.message).toBe('Service unavailable');
  });

  describe('ARN mode', () => {
    it('pauses using ARN without loading project config', async () => {
      mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
        configId: 'my-cfg-id',
        executionStatus: 'DISABLED',
        status: 'ACTIVE',
      });

      const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/my-cfg-id';
      const result = await handlePauseResume({ name: '', arn }, 'pause');

      assert(result.success);
      expect(result.executionStatus).toBe('DISABLED');
      expect(mockLoadDeployedProjectConfig).not.toHaveBeenCalled();
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
        region: 'us-west-2',
        onlineEvaluationConfigId: 'my-cfg-id',
        executionStatus: 'DISABLED',
      });
    });

    it('resumes using ARN with region override', async () => {
      mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
        configId: 'my-cfg-id',
        executionStatus: 'ENABLED',
        status: 'ACTIVE',
      });

      const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/my-cfg-id';
      const result = await handlePauseResume({ name: '', arn, region: 'eu-west-1' }, 'resume');

      assert(result.success);
      expect(result.executionStatus).toBe('ENABLED');
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
        region: 'eu-west-1',
        onlineEvaluationConfigId: 'my-cfg-id',
        executionStatus: 'ENABLED',
      });
    });

    it('returns error for invalid ARN', async () => {
      const result = await handlePauseResume({ name: '', arn: 'not-an-arn' }, 'pause');

      assert(!result.success);
      expect(result.error.message).toContain('Invalid online eval config ARN');
    });

    it('returns error when config ID cannot be extracted from ARN', async () => {
      const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:some-other-resource/foo';
      const result = await handlePauseResume({ name: '', arn }, 'pause');

      assert(!result.success);
      expect(result.error.message).toContain('Could not extract config ID');
    });
  });
});
