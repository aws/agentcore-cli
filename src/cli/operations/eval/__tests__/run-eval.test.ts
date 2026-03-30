import { handleRunEval } from '../run-eval.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockResolveAgent = vi.fn();
const mockLoadDeployedProjectConfig = vi.fn();
const mockEvaluate = vi.fn();
const mockGetEvaluator = vi.fn();
const mockSaveEvalRun = vi.fn();
const mockGenerateFilename = vi.fn();
const mockSend = vi.fn();
const mockGetCredentialProvider = vi.fn().mockReturnValue({});
const mockWriteFileSync = vi.fn();

vi.mock('../../resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadDeployedProjectConfig(),
  resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
}));

vi.mock('../../../aws/agentcore', () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  getEvaluator: (...args: unknown[]) => mockGetEvaluator(...args),
}));

vi.mock('../../../aws', () => ({
  getCredentialProvider: () => mockGetCredentialProvider(),
}));

vi.mock('../storage', () => ({
  generateFilename: (...args: unknown[]) => mockGenerateFilename(...args),
  saveEvalRun: (...args: unknown[]) => mockSaveEvalRun(...args),
}));

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send = mockSend;
  },
  StartQueryCommand: class {
    constructor(public input: unknown) {}
  },
  GetQueryResultsCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeployedContext({
  agentName = 'my-agent',
  runtimeId = 'rt-123',
  evaluators = {} as Record<string, { evaluatorId: string }>,
} = {}) {
  return {
    project: {
      runtimes: [{ name: agentName }],
      onlineEvalConfigs: [],
    },
    awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111222333444' }],
    deployedState: {
      targets: {
        dev: {
          resources: {
            runtimes: {
              [agentName]: {
                runtimeId,
                runtimeArn: `arn:aws:bedrock:us-east-1:111222333444:agent-runtime/${runtimeId}`,
                roleArn: 'arn:aws:iam::111222333444:role/test',
              },
            },
            evaluators,
          },
        },
      },
    },
  };
}

function makeOtelSpanRow(sessionId: string, traceId: string, spanBody: Record<string, unknown> = {}) {
  const message = JSON.stringify({
    scope: { name: 'strands.telemetry.tracer' },
    body: spanBody,
    traceId,
  });
  return [
    { field: '@message', value: message },
    { field: 'sessionId', value: sessionId },
    { field: 'traceId', value: traceId },
  ];
}

function makeToolCallSpanRow(sessionId: string, traceId: string, spanId: string, toolName: string) {
  const message = JSON.stringify({
    scope: { name: 'strands.telemetry.tracer' },
    traceId,
    spanId,
    kind: 'CLIENT',
    attributes: { 'gen_ai.tool.name': toolName },
  });
  return [
    { field: '@message', value: message },
    { field: 'sessionId', value: sessionId },
    { field: 'traceId', value: traceId },
  ];
}

function setupCloudWatchToReturn(spanRows: unknown[][], runtimeLogRows: unknown[][] = []) {
  let queryCount = 0;
  mockSend.mockImplementation((cmd: { input: unknown }) => {
    const input = cmd.input as Record<string, unknown>;

    if ('queryString' in input) {
      // StartQueryCommand
      queryCount++;
      return Promise.resolve({ queryId: `q-${queryCount}` });
    }

    // GetQueryResultsCommand — return Complete immediately
    if (queryCount === 1) {
      return Promise.resolve({ status: 'Complete', results: spanRows });
    }
    return Promise.resolve({ status: 'Complete', results: runtimeLogRows });
  });
}

describe('handleRunEval', () => {
  beforeEach(() => {
    mockGenerateFilename.mockReturnValue('eval_2025-01-15_10-00-00');
    mockSaveEvalRun.mockReturnValue('/tmp/eval-results/eval_2025-01-15_10-00-00.json');
  });

  afterEach(() => vi.clearAllMocks());

  // ─── Context resolution ───────────────────────────────────────────────────

  it('returns error when agent resolution fails', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({});
    mockResolveAgent.mockReturnValue({ success: false, error: 'No agents defined' });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No agents defined');
  });

  it('returns error when a custom evaluator is not found in deployed state', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const result = await handleRunEval({ evaluator: ['MissingEval'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('MissingEval');
    expect(result.error).toContain('not found in deployed state');
  });

  it('resolves builtin evaluators without deployed state lookup', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    // No spans found — will return before calling evaluate
    setupCloudWatchToReturn([]);

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    // Fails because no spans, but NOT because evaluator wasn't found
    expect(result.error).toContain('No session spans found');
  });

  it('resolves custom evaluator name to deployed evaluator ID', async () => {
    const ctx = makeDeployedContext({
      evaluators: { MyCustomEval: { evaluatorId: 'eval-custom-id' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['MyCustomEval'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'eval-custom-id' }));
  });

  it('extracts evaluator ID from ARN when --evaluator-arn is passed', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({
      evaluator: [],
      evaluatorArn: ['arn:aws:bedrock:us-east-1:123:evaluator/my-eval-id'],
      days: 7,
    });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'my-eval-id' }));
  });

  // ─── No sessions ──────────────────────────────────────────────────────────

  it('returns error when no session spans are found', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([]);

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No session spans found');
    expect(result.error).toContain('my-agent');
  });

  // ─── Successful evaluation ────────────────────────────────────────────────

  it('runs evaluation across sessions and computes aggregate score', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1'), makeOtelSpanRow('session-2', 'trace-2')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate
      .mockResolvedValueOnce({
        evaluationResults: [
          {
            value: 4.0,
            context: { spanContext: { sessionId: 'session-1', traceId: 'trace-1' } },
            tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        ],
      })
      .mockResolvedValueOnce({
        evaluationResults: [
          {
            value: 2.0,
            context: { spanContext: { sessionId: 'session-2', traceId: 'trace-2' } },
            tokenUsage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
          },
        ],
      });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run!.sessionCount).toBe(2);
    expect(result.run!.results).toHaveLength(1);

    const evalResult = result.run!.results[0]!;
    expect(evalResult.aggregateScore).toBe(3.0); // (4 + 2) / 2
    expect(evalResult.sessionScores).toHaveLength(2);
    expect(evalResult.tokenUsage).toEqual({ inputTokens: 180, outputTokens: 90, totalTokens: 270 });
  });

  it('excludes errored sessions from aggregate score', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [
        { value: 5.0, context: { spanContext: { sessionId: 's1' } } },
        { value: 0, errorMessage: 'something failed', context: { spanContext: { sessionId: 's2' } } },
      ],
    });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    const evalResult = result.run!.results[0]!;
    // Only the non-errored session (value 5.0) should be in the aggregate
    expect(evalResult.aggregateScore).toBe(5.0);
    expect(evalResult.sessionScores).toHaveLength(2);
  });

  // ─── Output handling ──────────────────────────────────────────────────────

  it('saves to default location when no output option', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockSaveEvalRun).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(result.filePath).toBe('/tmp/eval-results/eval_2025-01-15_10-00-00.json');
  });

  it('writes to custom output path when --output is specified', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      output: '/tmp/my-output.json',
    });

    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/my-output.json', expect.any(String));
    expect(mockSaveEvalRun).not.toHaveBeenCalled();
    expect(result.filePath).toBe('/tmp/my-output.json');
  });

  // ─── Multiple evaluators ─────────────────────────────────────────────────

  it('runs multiple evaluators and returns separate results for each', async () => {
    const ctx = makeDeployedContext({
      evaluators: { CustomEval: { evaluatorId: 'eval-custom' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);

    mockEvaluate
      .mockResolvedValueOnce({
        evaluationResults: [{ value: 0.9, context: { spanContext: { sessionId: 's1' } } }],
      })
      .mockResolvedValueOnce({
        evaluationResults: [{ value: 4.5, context: { spanContext: { sessionId: 's1' } } }],
      });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate', 'CustomEval'],
      days: 7,
    });

    expect(result.success).toBe(true);
    expect(result.run!.results).toHaveLength(2);
    expect(result.run!.results[0]!.evaluator).toBe('Builtin.GoalSuccessRate');
    expect(result.run!.results[0]!.aggregateScore).toBe(0.9);
    expect(result.run!.results[1]!.evaluator).toBe('CustomEval');
    expect(result.run!.results[1]!.aggregateScore).toBe(4.5);
  });

  // ─── ARN mode ─────────────────────────────────────────────────────────────

  it('resolves context from agent runtime ARN without project config', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/rt-arn-test',
      evaluator: ['Builtin.Helpfulness'],
      evaluatorArn: [],
      days: 3,
    });

    expect(result.success).toBe(true);
    expect(result.run!.agent).toBe('rt-arn-test');
    expect(mockLoadDeployedProjectConfig).not.toHaveBeenCalled();
    expect(mockResolveAgent).not.toHaveBeenCalled();
  });

  it('uses --region override in ARN mode', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/rt-region-test',
      evaluator: ['Builtin.Helpfulness'],
      region: 'eu-west-1',
      days: 7,
    });

    expect(result.success).toBe(true);
    // Should not load project config
    expect(mockLoadDeployedProjectConfig).not.toHaveBeenCalled();
  });

  it('resolves evaluator ARNs in ARN mode', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 5.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc',
      evaluator: [],
      evaluatorArn: ['arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/eval-xyz'],
      days: 7,
    });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'eval-xyz' }));
  });

  it('returns error for invalid ARN format', async () => {
    const result = await handleRunEval({
      agentArn: 'not-an-arn',
      evaluator: ['Builtin.Helpfulness'],
      days: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid agent runtime ARN');
  });

  it('rejects custom evaluator names in ARN mode', async () => {
    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc',
      evaluator: ['MyCustomEval'],
      days: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be resolved in ARN mode');
  });

  it('saves to cwd in ARN mode when no --output is specified', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-save-test',
      evaluator: ['Builtin.Helpfulness'],
      days: 7,
    });

    expect(result.success).toBe(true);
    // Should write to cwd, not call saveEvalRun (which requires a project)
    expect(mockSaveEvalRun).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('eval_2025-01-15_10-00-00.json'),
      expect.any(String)
    );
    expect(result.filePath).toContain('eval_2025-01-15_10-00-00.json');
  });

  it('saves to --output path in ARN mode', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-output-test',
      evaluator: ['Builtin.Helpfulness'],
      days: 7,
      output: '/tmp/custom-eval.json',
    });

    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/custom-eval.json', expect.any(String));
    expect(result.filePath).toBe('/tmp/custom-eval.json');
  });

  it('returns error when no evaluators in ARN mode', async () => {
    const result = await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc',
      evaluator: [],
      days: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No evaluators specified');
  });

  // ─── Endpoint selection ──────────────────────────────────────────────────

  it('uses --endpoint option to construct runtime log group', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7, endpoint: 'PROMPT_V1' });

    // The second CloudWatch query (runtime logs) should target the PROMPT_V1 log group
    const runtimeLogCall = mockSend.mock.calls.find((c: unknown[]) => {
      const input = (c[0] as { input?: { logGroupName?: string } }).input;
      return input?.logGroupName?.includes('PROMPT_V1');
    });
    expect(runtimeLogCall).toBeDefined();
  });

  it('uses AGENTCORE_RUNTIME_ENDPOINT env var when --endpoint is not provided', async () => {
    const originalEnv = process.env.AGENTCORE_RUNTIME_ENDPOINT;
    process.env.AGENTCORE_RUNTIME_ENDPOINT = 'CUSTOM_V2';

    try {
      const ctx = makeDeployedContext();
      mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
      mockResolveAgent.mockReturnValue({
        success: true,
        agent: {
          agentName: 'my-agent',
          targetName: 'dev',
          region: 'us-east-1',
          accountId: '111222333444',
          runtimeId: 'rt-123',
        },
      });

      const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
      setupCloudWatchToReturn(spanRows);

      mockEvaluate.mockResolvedValue({
        evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
      });

      await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

      const runtimeLogCall = mockSend.mock.calls.find((c: unknown[]) => {
        const input = (c[0] as { input?: { logGroupName?: string } }).input;
        return input?.logGroupName?.includes('CUSTOM_V2');
      });
      expect(runtimeLogCall).toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AGENTCORE_RUNTIME_ENDPOINT;
      } else {
        process.env.AGENTCORE_RUNTIME_ENDPOINT = originalEnv;
      }
    }
  });

  it('--endpoint takes precedence over AGENTCORE_RUNTIME_ENDPOINT env var', async () => {
    const originalEnv = process.env.AGENTCORE_RUNTIME_ENDPOINT;
    process.env.AGENTCORE_RUNTIME_ENDPOINT = 'ENV_ENDPOINT';

    try {
      const ctx = makeDeployedContext();
      mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
      mockResolveAgent.mockReturnValue({
        success: true,
        agent: {
          agentName: 'my-agent',
          targetName: 'dev',
          region: 'us-east-1',
          accountId: '111222333444',
          runtimeId: 'rt-123',
        },
      });

      const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
      setupCloudWatchToReturn(spanRows);

      mockEvaluate.mockResolvedValue({
        evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
      });

      await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7, endpoint: 'FLAG_ENDPOINT' });

      const flagCall = mockSend.mock.calls.find((c: unknown[]) => {
        const input = (c[0] as { input?: { logGroupName?: string } }).input;
        return input?.logGroupName?.includes('FLAG_ENDPOINT');
      });
      const envCall = mockSend.mock.calls.find((c: unknown[]) => {
        const input = (c[0] as { input?: { logGroupName?: string } }).input;
        return input?.logGroupName?.includes('ENV_ENDPOINT');
      });
      expect(flagCall).toBeDefined();
      expect(envCall).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AGENTCORE_RUNTIME_ENDPOINT;
      } else {
        process.env.AGENTCORE_RUNTIME_ENDPOINT = originalEnv;
      }
    }
  });

  it('uses --endpoint in ARN mode', async () => {
    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    await handleRunEval({
      agentArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/rt-arn-ep',
      evaluator: ['Builtin.Helpfulness'],
      days: 3,
      endpoint: 'PROMPT_V1',
    });

    const runtimeLogCall = mockSend.mock.calls.find((c: unknown[]) => {
      const input = (c[0] as { input?: { logGroupName?: string } }).input;
      return input?.logGroupName?.includes('PROMPT_V1');
    });
    expect(runtimeLogCall).toBeDefined();
  });

  // ─── Evaluator-level grouping ────────────────────────────────────────────

  it('sends targetTraceIds for TRACE-level builtin evaluators', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1'), makeOtelSpanRow('session-1', 'trace-2')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1', traceId: 'trace-1' } } }],
    });

    // Builtin.Helpfulness is TRACE-level
    const result = await handleRunEval({ evaluator: ['Builtin.Helpfulness'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTraceIds: expect.arrayContaining(['trace-1', 'trace-2']),
      })
    );
  });

  it('does not send targetTraceIds for SESSION-level evaluators', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    // Builtin.GoalSuccessRate is SESSION-level
    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTraceIds: undefined,
        targetSpanIds: undefined,
      })
    );
  });

  it('sends targetSpanIds for TOOL_CALL-level evaluators', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeToolCallSpanRow('session-1', 'trace-1', 'span-tool-1', 'calculator')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 5.0, context: { spanContext: { sessionId: 'session-1', spanId: 'span-tool-1' } } }],
    });

    // Builtin.ToolSelectionAccuracy is TOOL_CALL-level
    const result = await handleRunEval({ evaluator: ['Builtin.ToolSelectionAccuracy'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSpanIds: ['span-tool-1'],
      })
    );
  });

  it('batches targetSpanIds into chunks of 10 for TOOL_CALL evaluators', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    // Create 12 tool call spans in one session
    const spanRows = Array.from({ length: 12 }, (_, i) =>
      makeToolCallSpanRow('session-1', 'trace-1', `span-tool-${i}`, `tool-${i}`)
    );
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 5.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['Builtin.ToolSelectionAccuracy'], days: 7 });

    expect(result.success).toBe(true);
    // Should be called twice: first batch of 10, second batch of 2
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSpanIds: expect.arrayContaining(['span-tool-0']) as string[],
      })
    );

    const firstCallSpanIds = (mockEvaluate.mock.calls[0] as [{ targetSpanIds: string[] }])[0].targetSpanIds;
    const secondCallSpanIds = (mockEvaluate.mock.calls[1] as [{ targetSpanIds: string[] }])[0].targetSpanIds;
    expect(firstCallSpanIds).toHaveLength(10);
    expect(secondCallSpanIds).toHaveLength(2);
  });

  it('fetches level from API for custom evaluators', async () => {
    const ctx = makeDeployedContext({
      evaluators: { MyTraceEval: { evaluatorId: 'eval-trace-custom' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    // Mock getEvaluator to return TRACE level for the custom evaluator
    mockGetEvaluator.mockResolvedValue({
      evaluatorId: 'eval-trace-custom',
      evaluatorName: 'MyTraceEval',
      level: 'TRACE',
      status: 'ACTIVE',
    });

    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1', traceId: 'trace-1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['MyTraceEval'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockGetEvaluator).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'eval-trace-custom' }));
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTraceIds: ['trace-1'],
      })
    );
  });

  it('defaults to SESSION level when getEvaluator fails for custom evaluator', async () => {
    const ctx = makeDeployedContext({
      evaluators: { FailingEval: { evaluatorId: 'eval-failing' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    mockGetEvaluator.mockRejectedValue(new Error('Not found'));

    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['FailingEval'], days: 7 });

    expect(result.success).toBe(true);
    // Should default to SESSION (no target IDs)
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTraceIds: undefined,
        targetSpanIds: undefined,
      })
    );
  });

  // ─── Session/trace filtering ─────────────────────────────────────────────

  function getFirstQueryString(): string {
    const call = mockSend.mock.calls.find((c: unknown[]) => {
      const input = (c[0] as { input?: { queryString?: string } }).input;
      return input?.queryString !== undefined;
    });
    return (call![0] as { input: { queryString: string } }).input.queryString;
  }

  it('filters CloudWatch query by --session-id', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('session-abc', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-abc' } } }],
    });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      sessionId: 'session-abc',
    });

    expect(result.success).toBe(true);
    const query = getFirstQueryString();
    expect(query).toContain("filter attributes.session.id = 'session-abc'");
  });

  it('filters CloudWatch query by --trace-id', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-xyz')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 'session-1', traceId: 'trace-xyz' } } }],
    });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      traceId: 'trace-xyz',
    });

    expect(result.success).toBe(true);
    const query = getFirstQueryString();
    expect(query).toContain("filter traceId = 'trace-xyz'");
  });

  it('sanitizes --session-id and --trace-id values', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([]);

    await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      sessionId: "sess'; DROP TABLE--",
      traceId: "trace'; DROP TABLE--",
    });

    const query = getFirstQueryString();
    expect(query).toContain("filter attributes.session.id = 'sess; DROP TABLE--'");
    expect(query).toContain("filter traceId = 'trace; DROP TABLE--'");
    expect(query).not.toContain("sess'");
  });

  // ─── Query sanitization ───────────────────────────────────────────────────

  it('sanitizes runtimeId in CloudWatch query to prevent injection', async () => {
    const ctx = makeDeployedContext({ runtimeId: "rt-123'; DROP TABLE" });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: "rt-123'; DROP TABLE",
      },
    });

    setupCloudWatchToReturn([]);

    await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    const queryString = getFirstQueryString();
    expect(queryString).not.toContain("'rt-123'; DROP TABLE'");
    expect(queryString).toContain('rt-123; DROP TABLE');
  });

  // ─── Ground truth / reference inputs ────────────────────────────────────

  function setupDefaultAgent() {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });
  }

  it('passes expectedTrajectory as toolNames in evaluationReferenceInputs', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      expectedTrajectory: ['tool_1', 'tool_2', 'tool_3'],
    });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationReferenceInputs: expect.arrayContaining([
          expect.objectContaining({
            expectedTrajectory: { toolNames: ['tool_1', 'tool_2', 'tool_3'] },
          }),
        ]),
      })
    );
  });

  it('passes a single-element expectedTrajectory array', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      expectedTrajectory: ['tool_1'],
    });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationReferenceInputs: expect.arrayContaining([
          expect.objectContaining({
            expectedTrajectory: { toolNames: ['tool_1'] },
          }),
        ]),
      })
    );
  });

  it('does not include evaluationReferenceInputs when no ground truth provided', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
    });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationReferenceInputs: undefined,
      })
    );
  });

  it('passes assertions in evaluationReferenceInputs', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      assertions: ['response is relevant', 'no hallucinations'],
    });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationReferenceInputs: expect.arrayContaining([
          expect.objectContaining({
            assertions: [{ text: 'response is relevant' }, { text: 'no hallucinations' }],
          }),
        ]),
      })
    );
  });

  it('includes expectedTrajectory in saved run result referenceInputs', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      expectedTrajectory: ['tool_1', 'tool_2'],
    });

    expect(result.success).toBe(true);
    expect(result.run!.referenceInputs).toEqual({
      expectedTrajectory: ['tool_1', 'tool_2'],
    });
  });

  it('returns error when ground truth flags are used with multiple sessions', async () => {
    setupDefaultAgent();
    setupCloudWatchToReturn([makeOtelSpanRow('session-1', 'trace-1'), makeOtelSpanRow('session-2', 'trace-2')]);

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      assertions: ['Agent should greet user'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('require exactly one session');
  });
});
