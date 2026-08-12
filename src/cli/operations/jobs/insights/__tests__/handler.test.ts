import type { ConfigIO } from '../../../../../lib';
import { startBatchEvaluation } from '../../../../aws/agentcore-batch-evaluation';
import { insightsHandler, validateLookbackDays } from '../handler.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../aws/agentcore-batch-evaluation', () => ({
  deleteBatchEvaluation: vi.fn(),
  generateClientToken: vi.fn().mockReturnValue('client-token'),
  getBatchEvaluation: vi.fn(),
  startBatchEvaluation: vi.fn(),
}));

vi.mock('../../../../logging/exec-logger', () => ({
  ExecLogger: class {
    logFilePath = undefined;
    endStep = vi.fn();
    finalize = vi.fn();
    log = vi.fn();
    startStep = vi.fn();
  },
}));

const mockStartBatchEvaluation = vi.mocked(startBatchEvaluation);

function configIO(): ConfigIO {
  return {
    readProjectSpec: vi.fn().mockResolvedValue({ name: 'TestProject', runtimes: [{ name: 'test-agent' }] }),
    readDeployedState: vi.fn().mockResolvedValue({
      targets: {
        default: {
          resources: {
            runtimes: {
              'test-agent': {
                runtimeId: 'runtime-123',
                runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123',
              },
            },
          },
        },
      },
    }),
    resolveAWSDeploymentTargets: vi.fn().mockResolvedValue([{ region: 'us-east-1' }]),
  } as unknown as ConfigIO;
}

const startResult = {
  batchEvaluationId: 'evaluation-123',
  batchEvaluationArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluation/evaluation-123',
  name: 'insights-job',
  status: 'PENDING',
};

describe('insightsHandler.create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartBatchEvaluation.mockResolvedValue(startResult);
  });

  it('forwards the KMS key ARN to the batch evaluation API', async () => {
    const kmsKeyArn = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';

    const result = await insightsHandler.create(
      {
        agent: 'test-agent',
        insights: ['Builtin.Insight.FailureAnalysis'],
        name: 'insights_job',
        kmsKeyArn,
      },
      configIO()
    );

    expect(result.success).toBe(true);
    expect(mockStartBatchEvaluation).toHaveBeenCalledWith(expect.objectContaining({ kmsKeyArn }));
  });

  it('leaves the KMS key ARN undefined when the option is omitted', async () => {
    const result = await insightsHandler.create(
      {
        agent: 'test-agent',
        insights: ['Builtin.Insight.FailureAnalysis'],
        name: 'insights_job',
      },
      configIO()
    );

    expect(result.success).toBe(true);
    expect(mockStartBatchEvaluation).toHaveBeenCalledWith(expect.objectContaining({ kmsKeyArn: undefined }));
  });
});

describe('validateLookbackDays', () => {
  it('accepts positive integers', () => {
    expect(() => validateLookbackDays(1)).not.toThrow();
    expect(() => validateLookbackDays(7)).not.toThrow();
    expect(() => validateLookbackDays(30)).not.toThrow();
  });

  it('rejects negative values', () => {
    expect(() => validateLookbackDays(-5)).toThrow('positive integer');
    expect(() => validateLookbackDays(-1)).toThrow('positive integer');
  });

  it('rejects zero', () => {
    expect(() => validateLookbackDays(0)).toThrow('positive integer');
  });

  it('rejects non-integer values', () => {
    expect(() => validateLookbackDays(2.5)).toThrow('positive integer');
    expect(() => validateLookbackDays(0.5)).toThrow('positive integer');
  });
});
