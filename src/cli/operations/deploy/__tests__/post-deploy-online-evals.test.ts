import { enableOnlineEvalConfigs } from '../post-deploy-online-evals';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdateOnlineEvalExecutionStatus } = vi.hoisted(() => ({
  mockUpdateOnlineEvalExecutionStatus: vi.fn(),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  updateOnlineEvalExecutionStatus: mockUpdateOnlineEvalExecutionStatus,
}));

function makeOnlineEvalConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'MyEval',
    agent: 'my-agent',
    evaluators: ['Builtin.Faithfulness'],
    samplingRate: 10,
    enableOnCreate: true,
    ...overrides,
  };
}

const deployedConfigs = {
  MyEval: {
    onlineEvaluationConfigId: 'oec-123',
    onlineEvaluationConfigArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-123',
  },
};

describe('enableOnlineEvalConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
      configId: 'oec-123',
      executionStatus: 'ENABLED',
      status: 'ACTIVE',
    });
  });

  describe('enablement', () => {
    it('enables config with enableOnCreate true', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig()],
        deployedOnlineEvalConfigs: deployedConfigs,
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.status).toBe('enabled');
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
        region: 'us-east-1',
        onlineEvaluationConfigId: 'oec-123',
        executionStatus: 'ENABLED',
      });
    });

    it('enables config when enableOnCreate is undefined (defaults to enable)', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig({ enableOnCreate: undefined })],
        deployedOnlineEvalConfigs: deployedConfigs,
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results[0]!.status).toBe('enabled');
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalled();
    });

    it('skips config with enableOnCreate false', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig({ enableOnCreate: false })],
        deployedOnlineEvalConfigs: deployedConfigs,
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results[0]!.status).toBe('skipped');
      expect(mockUpdateOnlineEvalExecutionStatus).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('reports error when config not in deployed state', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig({ name: 'Missing' })],
        deployedOnlineEvalConfigs: deployedConfigs,
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toContain('not found in deployed state');
    });

    it('reports error when API call fails', async () => {
      mockUpdateOnlineEvalExecutionStatus.mockRejectedValue(new Error('AccessDenied'));

      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig()],
        deployedOnlineEvalConfigs: deployedConfigs,
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toBe('AccessDenied');
    });

    it('hasErrors is true when any config fails', async () => {
      mockUpdateOnlineEvalExecutionStatus
        .mockResolvedValueOnce({ configId: 'oec-123', executionStatus: 'ENABLED', status: 'ACTIVE' })
        .mockRejectedValueOnce(new Error('Throttled'));

      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig({ name: 'MyEval' }), makeOnlineEvalConfig({ name: 'OtherEval' })],
        deployedOnlineEvalConfigs: {
          ...deployedConfigs,
          OtherEval: {
            onlineEvaluationConfigId: 'oec-456',
            onlineEvaluationConfigArn:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-456',
          },
        },
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('enabled');
      expect(result.results[1]!.status).toBe('error');
    });
  });

  describe('multiple configs', () => {
    it('processes multiple configs independently', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [makeOnlineEvalConfig({ name: 'MyEval' }), makeOnlineEvalConfig({ name: 'OtherEval' })],
        deployedOnlineEvalConfigs: {
          ...deployedConfigs,
          OtherEval: {
            onlineEvaluationConfigId: 'oec-456',
            onlineEvaluationConfigArn:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-456',
          },
        },
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]!.status).toBe('enabled');
      expect(result.results[1]!.status).toBe('enabled');
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledTimes(2);
    });

    it('mixed enableOnCreate values', async () => {
      const result = await enableOnlineEvalConfigs({
        region: 'us-east-1',
        onlineEvalConfigs: [
          makeOnlineEvalConfig({ name: 'MyEval', enableOnCreate: true }),
          makeOnlineEvalConfig({ name: 'OtherEval', enableOnCreate: false }),
        ],
        deployedOnlineEvalConfigs: {
          ...deployedConfigs,
          OtherEval: {
            onlineEvaluationConfigId: 'oec-456',
            onlineEvaluationConfigArn:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-456',
          },
        },
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results[0]!.status).toBe('enabled');
      expect(result.results[1]!.status).toBe('skipped');
      expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledTimes(1);
    });
  });
});
