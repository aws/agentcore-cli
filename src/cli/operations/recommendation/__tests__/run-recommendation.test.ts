import { runRecommendationCommand } from '../run-recommendation';
import assert from 'node:assert';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies — paths are relative to the file under test (run-recommendation.ts)
const mockReadProjectSpec = vi.fn().mockResolvedValue({ name: 'test-project' });
const mockReadDeployedState = vi.fn().mockResolvedValue({
  targets: {
    default: {
      resources: {
        runtimes: {
          MyAgent: {
            runtimeId: 'rt-abc123',
            runtimeArn: 'arn:aws:bedrock:us-east-1:998846730471:agent-runtime/rt-abc123',
          },
        },
        evaluators: {
          MyEvaluator: {
            evaluatorArn: 'arn:aws:bedrock-agentcore:us-east-1:998846730471:evaluator/my-eval-abc1234567',
          },
        },
      },
    },
  },
});

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    readDeployedState = mockReadDeployedState;
    resolveAWSDeploymentTargets = vi.fn().mockResolvedValue([{ region: 'us-east-1' }]);
  },
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  ValidationError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ValidationError';
    }
  },
  TimeoutError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'TimeoutError';
    }
  },
}));

vi.mock('../../../aws/region', () => ({
  detectRegion: vi.fn().mockResolvedValue({ region: 'us-east-1' }),
}));

const mockStartRecommendation = vi.fn();
const mockGetRecommendation = vi.fn();

vi.mock('../../../aws/agentcore-recommendation', () => ({
  startRecommendation: (...args: unknown[]) => mockStartRecommendation(...args),
  getRecommendation: (...args: unknown[]) => mockGetRecommendation(...args),
}));

const mockFetchSessionSpans = vi.fn();
vi.mock('../fetch-session-spans', () => ({
  fetchSessionSpans: (...args: unknown[]) => mockFetchSessionSpans(...args),
}));

const mockReadFileSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: (...args: unknown[]) => mockReadFileSync(...args) };
});

describe('runRecommendationCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when agent is not deployed', async () => {
    mockReadDeployedState.mockResolvedValueOnce({ targets: {} });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'NonExistentAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'You are helpful.',
      traceSource: 'cloudwatch',
    });

    assert(!result.success);
    expect(result.error.message).toContain('NonExistentAgent');
    expect(result.error.message).toContain('not deployed');
  });

  it('returns error when evaluator cannot be resolved', async () => {
    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['UnknownEvaluator'],
      inputSource: 'inline',
      inlineContent: 'You are helpful.',
      traceSource: 'cloudwatch',
    });

    assert(!result.success);
    expect(result.error.message).toContain('UnknownEvaluator');
    expect(result.error.message).toContain('not found');
  });

  it('returns result on COMPLETED status', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-001',
      recommendationArn: 'arn:rec-001',
      name: 'test-rec',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-001',
      status: 'COMPLETED',
      createdAt: '2026-03-30T00:00:00Z',
      completedAt: '2026-03-30T00:01:00Z',
      recommendationResult: {
        systemPromptRecommendationResult: {
          recommendedSystemPrompt: 'Optimized prompt',
          explanation: 'Made clearer',
        },
      },
    });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'You are helpful.',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    assert(result.success);
    expect(result.recommendationId).toBe('rec-001');
    expect(result.status).toBe('COMPLETED');
    expect(result.result?.systemPromptRecommendationResult?.recommendedSystemPrompt).toBe('Optimized prompt');
  });

  it('returns error on FAILED status', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-002',
      recommendationArn: 'arn:rec-002',
      name: 'test-rec',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-002',
      status: 'FAILED',
    });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'You are helpful.',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    assert(!result.success);
    expect(result.error.message).toContain('FAILED');
    expect(result.recommendationId).toBe('rec-002');
  });

  it('expands Builtin.* evaluator to full ARN in startRecommendation call', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-003',
      status: 'COMPLETED',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-003',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const evaluators = callArgs.recommendationConfig.systemPromptRecommendationConfig.evaluationConfig.evaluators;
    expect(evaluators[0].evaluatorArn).toBe('arn:aws:bedrock-agentcore:::evaluator/Builtin.Toxicity');
  });

  it('uses account ID from runtime ARN in log group ARN', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-004',
      status: 'COMPLETED',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-004',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const logGroupArn =
      callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces.cloudwatchLogs.logGroupArns[0];
    expect(logGroupArn).toContain(':998846730471:');
    expect(logGroupArn).not.toContain(':*:');
  });

  it('resolves custom evaluator from deployed state', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-005',
      status: 'COMPLETED',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-005',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['MyEvaluator'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const evaluators = callArgs.recommendationConfig.systemPromptRecommendationConfig.evaluationConfig.evaluators;
    expect(evaluators[0].evaluatorArn).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:998846730471:evaluator/my-eval-abc1234567'
    );
  });

  it('builds TOOL_DESCRIPTION_RECOMMENDATION config with toolName:description pairs', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-006',
      status: 'COMPLETED',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-006',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'TOOL_DESCRIPTION_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      tools: ['search:Search the web for info', 'calculate:Perform math calculations'],
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const tools =
      callArgs.recommendationConfig.toolDescriptionRecommendationConfig.toolDescription.toolDescriptionText.tools;
    expect(tools).toHaveLength(2);
    expect(tools[0].toolName).toBe('search');
    expect(tools[0].toolDescription.text).toBe('Search the web for info');
    expect(tools[1].toolName).toBe('calculate');
    expect(tools[1].toolDescription.text).toBe('Perform math calculations');
  });

  it('catches and returns errors from startRecommendation', async () => {
    mockStartRecommendation.mockRejectedValue(new Error('API timeout'));

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
    });

    assert(!result.success);
    expect(result.error.message).toContain('API timeout');
  });

  it('retries transient poll failures and succeeds', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-retry-ok',
      recommendationArn: 'arn:rec-retry-ok',
      name: 'test-rec',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
    });

    // First poll fails, second succeeds
    mockGetRecommendation.mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValueOnce({
      recommendationId: 'rec-retry-ok',
      status: 'COMPLETED',
      recommendationResult: {
        systemPromptRecommendationResult: { recommendedSystemPrompt: 'Better prompt' },
      },
    });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.recommendationId).toBe('rec-retry-ok');
    expect(mockGetRecommendation).toHaveBeenCalledTimes(2);
  });

  it('fails after max consecutive poll retries', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-retry-fail',
      recommendationArn: 'arn:rec-retry-fail',
      name: 'test-rec',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
    });

    mockGetRecommendation.mockRejectedValue(new Error('fetch failed'));

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    assert(!result.success);
    expect(result.error.message).toContain('consecutive errors');
    expect(result.error.message).toContain('fetch failed');
    expect(result.error.message).toContain('rec-retry-fail');
    expect(mockGetRecommendation).toHaveBeenCalledTimes(3);
  });

  it('times out after max poll duration', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-timeout',
      recommendationArn: 'arn:rec-timeout',
      name: 'test-rec',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-timeout',
      status: 'IN_PROGRESS',
    });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
      maxPollDurationMs: 0, // Immediately timeout
    });

    assert(!result.success);
    expect(result.error.message).toContain('Polling timed out');
    expect(result.error.message).toContain('rec-timeout');
  });

  it('reads system prompt from file when inputSource is file', async () => {
    mockReadFileSync.mockReturnValue('You are a healthcare assistant.');

    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-file',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-file',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Helpfulness'],
      inputSource: 'file',
      promptFile: '/tmp/prompt.txt',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/prompt.txt', 'utf-8');
    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const systemPrompt = callArgs.recommendationConfig.systemPromptRecommendationConfig.systemPrompt;
    expect(systemPrompt.text).toBe('You are a healthcare assistant.');
  });

  it('uses inline sessionSpans from spans-file trace source', async () => {
    const fakeSpans = [
      { traceId: 't1', spanId: 's1', body: {} },
      { traceId: 't1', spanId: 's2', body: {} },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(fakeSpans));

    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-spans',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-spans',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'spans-file',
      spansFile: '/tmp/spans.json',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const traces = callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces;
    expect(traces.sessionSpans).toHaveLength(2);
    expect(traces.cloudwatchLogs).toBeUndefined();
  });

  it('wraps single span object in array for spans-file', async () => {
    const singleSpan = { traceId: 't1', spanId: 's1', body: {} };
    mockReadFileSync.mockReturnValue(JSON.stringify(singleSpan));

    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-single',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-single',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'spans-file',
      spansFile: '/tmp/single.json',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const traces = callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces;
    expect(traces.sessionSpans).toHaveLength(1);
  });

  it('auto-fetches spans for tool-desc with sessions trace source', async () => {
    mockFetchSessionSpans.mockResolvedValue({
      spans: [
        { traceId: 't1', spanId: 's1', body: {} },
        { traceId: 't1', spanId: 's2', body: {} },
      ],
      spanRecordCount: 1,
      logRecordCount: 1,
    });

    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-autofetch',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-autofetch',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'TOOL_DESCRIPTION_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      tools: ['add_numbers:Add two numbers together'],
      traceSource: 'sessions',
      sessionIds: ['session-abc'],
      pollIntervalMs: 0,
    });

    expect(mockFetchSessionSpans).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        runtimeId: 'rt-abc123',
        sessionId: 'session-abc',
      })
    );

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const traces = callArgs.recommendationConfig.toolDescriptionRecommendationConfig.agentTraces;
    expect(traces.sessionSpans).toHaveLength(2);
    expect(traces.cloudwatchLogs).toBeUndefined();
  });

  it('throws when auto-fetch returns zero spans', async () => {
    mockFetchSessionSpans.mockResolvedValue({
      spans: [],
      spanRecordCount: 0,
      logRecordCount: 0,
    });

    const result = await runRecommendationCommand({
      type: 'TOOL_DESCRIPTION_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      tools: ['add_numbers:Add numbers'],
      traceSource: 'sessions',
      sessionIds: ['session-empty'],
      pollIntervalMs: 0,
    });

    assert(!result.success);
    expect(result.error.message).toContain('No spans found');
  });

  it('derives service name from runtimeId by stripping hash suffix', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-svc',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-svc',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const serviceNames =
      callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces.cloudwatchLogs.serviceNames;
    // runtimeId 'rt-abc123' → service name 'rt.DEFAULT' (strips '-abc123' suffix)
    expect(serviceNames[0]).toBe('rt.DEFAULT');
  });

  it('auto-fetches spans for system-prompt with sessions trace source', async () => {
    mockFetchSessionSpans.mockResolvedValue({ spans: [{ sessionId: 'sess-1', spans: [] }] });
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-sid',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-sid',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'sessions',
      sessionIds: ['sess-1'],
      pollIntervalMs: 0,
    });

    expect(mockFetchSessionSpans).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }));
    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const traces = callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces;
    expect(traces.sessionSpans).toBeDefined();
    expect(traces.cloudwatchLogs).toBeUndefined();
  });

  it('builds cloudwatch config with two log group ARNs', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-cw',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-cw',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      lookbackDays: 3,
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const cwConfig = callArgs.recommendationConfig.systemPromptRecommendationConfig.agentTraces.cloudwatchLogs;
    expect(cwConfig.logGroupArns).toHaveLength(2);
    expect(cwConfig.logGroupArns[0]).toContain('/aws/bedrock-agentcore/runtimes/rt-abc123-DEFAULT');
    expect(cwConfig.logGroupArns[1]).toContain('aws/spans');
    expect(cwConfig.startTime).toBeDefined();
    expect(cwConfig.endTime).toBeDefined();
  });

  it('extracts failure details from statusReasons and result error fields', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-fail-detail',
      recommendationArn: 'arn:rec-fail-detail',
      name: 'test',
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      status: 'PENDING',
      requestId: 'start-req-id',
    });

    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-fail-detail',
      status: 'FAILED',
      requestId: 'poll-req-id',
      statusReasons: ['Insufficient trace data'],
      recommendationResult: {
        systemPromptRecommendationResult: {
          errorCode: 'INSUFFICIENT_DATA',
          errorMessage: 'Not enough traces to generate recommendation',
        },
      },
    });

    const result = await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: ['Builtin.Toxicity'],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    assert(!result.success);
    expect(result.error.message).toContain('Insufficient trace data');
    expect(result.error.message).toContain('INSUFFICIENT_DATA');
    expect(result.error.message).toContain('Not enough traces');
    // Request IDs are logged to file only, not included in the error message
  });

  it('passes full ARN evaluator as-is', async () => {
    mockStartRecommendation.mockResolvedValue({
      recommendationId: 'rec-arn',
      status: 'COMPLETED',
    });
    mockGetRecommendation.mockResolvedValue({
      recommendationId: 'rec-arn',
      status: 'COMPLETED',
      recommendationResult: {},
    });

    const fullArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/custom-eval';
    await runRecommendationCommand({
      type: 'SYSTEM_PROMPT_RECOMMENDATION',
      agent: 'MyAgent',
      evaluators: [fullArn],
      inputSource: 'inline',
      inlineContent: 'test',
      traceSource: 'cloudwatch',
      pollIntervalMs: 0,
    });

    const callArgs = mockStartRecommendation.mock.calls[0]![0];
    const evaluators = callArgs.recommendationConfig.systemPromptRecommendationConfig.evaluationConfig.evaluators;
    expect(evaluators[0].evaluatorArn).toBe(fullArn);
  });
});
