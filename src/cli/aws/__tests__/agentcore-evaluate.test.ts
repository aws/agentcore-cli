import { evaluate } from '../agentcore.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send = mockSend;
  },
  EvaluateCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends evaluatorId and sessionSpans in the command', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [{ value: 4.0 }],
    });

    await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [{ traceId: 't1', spanId: 's1' }],
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluatorId).toBe('eval-123');
    expect(command.input.evaluationInput.sessionSpans).toEqual([{ traceId: 't1', spanId: 's1' }]);
  });

  it('includes spanIds target when targetSpanIds is provided', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [{ value: 3.0 }],
    });

    await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
      targetSpanIds: ['span-1', 'span-2'],
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluationTarget).toEqual({ spanIds: ['span-1', 'span-2'] });
  });

  it('includes traceIds target when targetTraceIds is provided', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [{ value: 3.0 }],
    });

    await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
      targetTraceIds: ['trace-1'],
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluationTarget).toEqual({ traceIds: ['trace-1'] });
  });

  it('prefers spanIds over traceIds when both are provided', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [{ value: 3.0 }],
    });

    await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
      targetSpanIds: ['span-1'],
      targetTraceIds: ['trace-1'],
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluationTarget).toEqual({ spanIds: ['span-1'] });
  });

  it('omits evaluationTarget when neither targetSpanIds nor targetTraceIds provided', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [{ value: 3.0 }],
    });

    await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
    });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.evaluationTarget).toBeUndefined();
  });

  it('throws when evaluationResults is undefined', async () => {
    mockSend.mockResolvedValue({ evaluationResults: undefined });

    await expect(evaluate({ region: 'us-east-1', evaluatorId: 'eval-123', sessionSpans: [] })).rejects.toThrow(
      'No evaluation results returned'
    );
  });

  it('maps response with spanContext correctly', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [
        {
          evaluatorArn: 'arn:aws:evaluator/eval-123',
          evaluatorId: 'eval-123',
          evaluatorName: 'MyEval',
          explanation: 'Good quality',
          value: 4.5,
          label: 'Excellent',
          errorMessage: undefined,
          errorCode: undefined,
          context: {
            spanContext: {
              sessionId: 'sess-1',
              traceId: 'trace-1',
              spanId: 'span-1',
            },
          },
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        },
      ],
    });

    const result = await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
    });

    expect(result.evaluationResults).toHaveLength(1);
    const r = result.evaluationResults[0]!;
    expect(r.evaluatorArn).toBe('arn:aws:evaluator/eval-123');
    expect(r.value).toBe(4.5);
    expect(r.explanation).toBe('Good quality');
    expect(r.context).toEqual({ sessionId: 'sess-1', traceId: 'trace-1', spanId: 'span-1' });
    expect(r.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('handles response without spanContext', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [
        {
          value: 3.0,
          context: undefined,
          tokenUsage: undefined,
        },
      ],
    });

    const result = await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
    });

    const r = result.evaluationResults[0]!;
    expect(r.context).toBeUndefined();
    expect(r.tokenUsage).toBeUndefined();
  });

  it('defaults token usage values to 0 when partially undefined', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [
        {
          value: 3.0,
          tokenUsage: {
            inputTokens: undefined,
            outputTokens: 25,
            totalTokens: undefined,
          },
        },
      ],
    });

    const result = await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
    });

    expect(result.evaluationResults[0]!.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 25,
      totalTokens: 0,
    });
  });

  it('maps error results correctly', async () => {
    mockSend.mockResolvedValue({
      evaluationResults: [
        {
          value: 0,
          errorMessage: 'Prompt template missing required field',
          errorCode: 'TEMPLATE_ERROR',
        },
      ],
    });

    const result = await evaluate({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
      sessionSpans: [],
    });

    const r = result.evaluationResults[0]!;
    expect(r.errorMessage).toBe('Prompt template missing required field');
    expect(r.errorCode).toBe('TEMPLATE_ERROR');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('AccessDeniedException'));

    await expect(evaluate({ region: 'us-east-1', evaluatorId: 'eval-123', sessionSpans: [] })).rejects.toThrow(
      'AccessDeniedException'
    );
  });
});
