import {
  getAgentRuntimeStatus,
  getEvaluator,
  getOnlineEvaluationConfig,
  listEvaluators,
  updateOnlineEvalExecutionStatus,
} from '../agentcore-control.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  GetAgentRuntimeCommand: class {
    constructor(public input: unknown) {}
  },
  GetEvaluatorCommand: class {
    constructor(public input: unknown) {}
  },
  GetOnlineEvaluationConfigCommand: class {
    constructor(public input: unknown) {}
  },
  ListEvaluatorsCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateOnlineEvaluationConfigCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('getAgentRuntimeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns runtime status', async () => {
    mockSend.mockResolvedValue({ status: 'ACTIVE' });

    const result = await getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-123' });
    expect(result.runtimeId).toBe('rt-123');
    expect(result.status).toBe('ACTIVE');
  });

  it('throws when no status returned', async () => {
    mockSend.mockResolvedValue({ status: undefined });

    await expect(getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-456' })).rejects.toThrow(
      'No status returned for runtime rt-456'
    );
  });

  it('passes correct runtimeId in command', async () => {
    mockSend.mockResolvedValue({ status: 'CREATING' });

    await getAgentRuntimeStatus({ region: 'us-west-2', runtimeId: 'rt-abc' });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.agentRuntimeId).toBe('rt-abc');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('Service unavailable'));

    await expect(getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-err' })).rejects.toThrow(
      'Service unavailable'
    );
  });
});

describe('getEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns evaluator details', async () => {
    mockSend.mockResolvedValue({
      evaluatorId: 'eval-123',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:evaluator/eval-123',
      evaluatorName: 'my-evaluator',
      level: 'SESSION',
      status: 'ACTIVE',
      description: 'A test evaluator',
    });

    const result = await getEvaluator({ region: 'us-east-1', evaluatorId: 'eval-123' });
    expect(result.evaluatorId).toBe('eval-123');
    expect(result.evaluatorName).toBe('my-evaluator');
    expect(result.level).toBe('SESSION');
    expect(result.status).toBe('ACTIVE');
    expect(result.description).toBe('A test evaluator');
  });

  it('throws when no evaluatorId in response', async () => {
    mockSend.mockResolvedValue({ evaluatorId: undefined });

    await expect(getEvaluator({ region: 'us-east-1', evaluatorId: 'eval-missing' })).rejects.toThrow(
      'No evaluator found for ID eval-missing'
    );
  });

  it('passes correct evaluatorId in command', async () => {
    mockSend.mockResolvedValue({
      evaluatorId: 'eval-abc',
      evaluatorName: 'test',
      level: 'TRACE',
      status: 'ACTIVE',
    });

    await getEvaluator({ region: 'us-west-2', evaluatorId: 'eval-abc' });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluatorId).toBe('eval-abc');
  });

  it('defaults level to SESSION when undefined', async () => {
    mockSend.mockResolvedValue({
      evaluatorId: 'eval-no-level',
      level: undefined,
      status: 'ACTIVE',
    });

    const result = await getEvaluator({ region: 'us-east-1', evaluatorId: 'eval-no-level' });
    expect(result.level).toBe('SESSION');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied'));

    await expect(getEvaluator({ region: 'us-east-1', evaluatorId: 'eval-err' })).rejects.toThrow('AccessDenied');
  });
});

describe('updateOnlineEvalExecutionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends DISABLED to pause and returns result', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'DISABLED',
      status: 'ACTIVE',
    });

    const result = await updateOnlineEvalExecutionStatus({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'DISABLED',
    });

    expect(result.configId).toBe('cfg-123');
    expect(result.executionStatus).toBe('DISABLED');
    expect(result.status).toBe('ACTIVE');
  });

  it('sends ENABLED to resume', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'cfg-456',
      executionStatus: 'ENABLED',
      status: 'ACTIVE',
    });

    const result = await updateOnlineEvalExecutionStatus({
      region: 'us-west-2',
      onlineEvaluationConfigId: 'cfg-456',
      executionStatus: 'ENABLED',
    });

    expect(result.configId).toBe('cfg-456');
    expect(result.executionStatus).toBe('ENABLED');
  });

  it('passes correct params in command', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'cfg-789',
      executionStatus: 'DISABLED',
      status: 'ACTIVE',
    });

    await updateOnlineEvalExecutionStatus({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-789',
      executionStatus: 'DISABLED',
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.onlineEvaluationConfigId).toBe('cfg-789');
    expect(command.input.executionStatus).toBe('DISABLED');
  });

  it('falls back to input values when response fields are undefined', async () => {
    mockSend.mockResolvedValue({});

    const result = await updateOnlineEvalExecutionStatus({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-fallback',
      executionStatus: 'ENABLED',
    });

    expect(result.configId).toBe('cfg-fallback');
    expect(result.executionStatus).toBe('ENABLED');
    expect(result.status).toBe('UNKNOWN');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('Throttling'));

    await expect(
      updateOnlineEvalExecutionStatus({
        region: 'us-east-1',
        onlineEvaluationConfigId: 'cfg-err',
        executionStatus: 'DISABLED',
      })
    ).rejects.toThrow('Throttling');
  });
});

describe('getOnlineEvaluationConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns config details with output log group', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'oec-123',
      onlineEvaluationConfigArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:online-eval/oec-123',
      onlineEvaluationConfigName: 'my-online-eval',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      description: 'Production eval',
      outputConfig: {
        cloudWatchConfig: { logGroupName: '/aws/bedrock-agentcore/evaluations/oec-123' },
      },
    });

    const result = await getOnlineEvaluationConfig({ region: 'us-east-1', configId: 'oec-123' });
    expect(result.configId).toBe('oec-123');
    expect(result.configName).toBe('my-online-eval');
    expect(result.status).toBe('ACTIVE');
    expect(result.executionStatus).toBe('ENABLED');
    expect(result.description).toBe('Production eval');
    expect(result.outputLogGroupName).toBe('/aws/bedrock-agentcore/evaluations/oec-123');
  });

  it('throws when no configId in response', async () => {
    mockSend.mockResolvedValue({ onlineEvaluationConfigId: undefined });

    await expect(getOnlineEvaluationConfig({ region: 'us-east-1', configId: 'oec-missing' })).rejects.toThrow(
      'No online evaluation config found for ID oec-missing'
    );
  });

  it('returns failureReason when present', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'oec-fail',
      onlineEvaluationConfigName: 'broken-eval',
      status: 'CREATE_FAILED',
      executionStatus: 'DISABLED',
      failureReason: 'IAM role not found',
    });

    const result = await getOnlineEvaluationConfig({ region: 'us-east-1', configId: 'oec-fail' });
    expect(result.status).toBe('CREATE_FAILED');
    expect(result.failureReason).toBe('IAM role not found');
  });

  it('handles missing outputConfig', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'oec-no-output',
      status: 'CREATING',
      executionStatus: 'DISABLED',
    });

    const result = await getOnlineEvaluationConfig({ region: 'us-east-1', configId: 'oec-no-output' });
    expect(result.outputLogGroupName).toBeUndefined();
  });

  it('passes correct configId in command', async () => {
    mockSend.mockResolvedValue({
      onlineEvaluationConfigId: 'oec-abc',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
    });

    await getOnlineEvaluationConfig({ region: 'us-west-2', configId: 'oec-abc' });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.onlineEvaluationConfigId).toBe('oec-abc');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('ResourceNotFoundException'));

    await expect(getOnlineEvaluationConfig({ region: 'us-east-1', configId: 'oec-err' })).rejects.toThrow(
      'ResourceNotFoundException'
    );
  });
});

describe('listEvaluators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns evaluator summaries', async () => {
    mockSend.mockResolvedValue({
      evaluators: [
        {
          evaluatorId: 'eval-1',
          evaluatorArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:evaluator/eval-1',
          evaluatorName: 'Faithfulness',
          evaluatorType: 'Builtin',
          status: 'ACTIVE',
        },
        {
          evaluatorId: 'eval-2',
          evaluatorArn: 'arn:aws:bedrock-agentcore:us-east-1:123456:evaluator/eval-2',
          evaluatorName: 'my-custom',
          evaluatorType: 'Custom',
          status: 'ACTIVE',
          description: 'A custom evaluator',
        },
      ],
    });

    const result = await listEvaluators({ region: 'us-east-1' });
    expect(result.evaluators).toHaveLength(2);
    expect(result.evaluators[0]!.evaluatorName).toBe('Faithfulness');
    expect(result.evaluators[0]!.evaluatorType).toBe('Builtin');
    expect(result.evaluators[1]!.evaluatorName).toBe('my-custom');
    expect(result.evaluators[1]!.description).toBe('A custom evaluator');
  });

  it('returns empty array when no evaluators', async () => {
    mockSend.mockResolvedValue({ evaluators: undefined });

    const result = await listEvaluators({ region: 'us-east-1' });
    expect(result.evaluators).toEqual([]);
  });

  it('passes maxResults and nextToken', async () => {
    mockSend.mockResolvedValue({ evaluators: [], nextToken: 'token-2' });

    const result = await listEvaluators({ region: 'us-east-1', maxResults: 5, nextToken: 'token-1' });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.maxResults).toBe(5);
    expect(command.input.nextToken).toBe('token-1');
    expect(result.nextToken).toBe('token-2');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('AccessDeniedException'));

    await expect(listEvaluators({ region: 'us-east-1' })).rejects.toThrow('AccessDeniedException');
  });
});
