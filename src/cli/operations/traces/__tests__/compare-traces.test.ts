import { ResourceNotFoundError } from '../../../../lib';
import { aggregateSpans, buildTraceComparison, compareTraces } from '../compare-traces';
import type { CloudWatchSpanRecord, QuerySpanRecordsOptions, TraceMetrics } from '../types';
import assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockQuerySpanRecords } = vi.hoisted(() => ({
  mockQuerySpanRecords: vi.fn(),
}));

vi.mock('../get-trace', () => ({
  querySpanRecords: (options: unknown) => mockQuerySpanRecords(options),
}));

// Base timestamp: divisible by 256 so nano values stay exactly representable as doubles.
const T0 = 1_700_000_000_000_000_000;

function nano(offsetMs: number): string {
  return String(T0 + offsetMs * 1_000_000);
}

function span(overrides: Partial<CloudWatchSpanRecord> & { spanId: string }): CloudWatchSpanRecord {
  return { traceId: 'trace-a', ...overrides };
}

function metrics(overrides: Partial<TraceMetrics>): TraceMetrics {
  return {
    traceId: 'trace-a',
    spanCount: 3,
    endToEndMs: 1000,
    timingSource: 'invocation-span',
    llmMs: 500,
    llmCalls: 1,
    toolMs: 200,
    toolCalls: 1,
    ...overrides,
  };
}

describe('aggregateSpans', () => {
  it('uses the POST /invocations server span for end-to-end latency', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6600),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        name: 'chat claude-3',
        genAiOperation: 'chat',
        startTimeUnixNano: nano(100),
        endTimeUnixNano: nano(3720),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.endToEndMs).toBe(6600);
    expect(result.metrics.timingSource).toBe('invocation-span');
    expect(result.metrics.spanCount).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to the span envelope with a warning when no invocation span exists', () => {
    const spans = [
      span({
        spanId: 'llm1',
        name: 'chat claude-3',
        genAiOperation: 'chat',
        startTimeUnixNano: nano(100),
        endTimeUnixNano: nano(3100),
      }),
      span({
        spanId: 'tool1',
        name: 'execute_tool weather',
        genAiOperation: 'execute_tool',
        startTimeUnixNano: nano(3200),
        endTimeUnixNano: nano(5200),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.endToEndMs).toBe(5100);
    expect(result.metrics.timingSource).toBe('span-envelope');
    expect(result.warnings).toEqual([
      expect.stringContaining('no POST /invocations server span found'),
    ]);
  });

  it('fails when no span has usable timing data', () => {
    const spans = [span({ spanId: 'a', name: 'chat claude-3' }), span({ spanId: 'b', name: 'execute_tool weather' })];

    const result = aggregateSpans('trace-a', spans);

    assert(!result.success);
    expect(result.error.message).toContain('no spans with timing data');
  });

  it('counts a nested provider LLM span as a single model call', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        name: 'chat claude-3',
        genAiOperation: 'chat',
        durationNano: String(3_000_000_000),
        startTimeUnixNano: nano(100),
        endTimeUnixNano: nano(3100),
      }),
      // Nested Bedrock client span for the same model call — must not double-count.
      span({
        spanId: 'bedrock1',
        parentSpanId: 'llm1',
        name: 'Bedrock Runtime.InvokeModel',
        kind: 'CLIENT',
        durationNano: String(2_800_000_000),
        startTimeUnixNano: nano(200),
        endTimeUnixNano: nano(3000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.llmCalls).toBe(1);
    expect(result.metrics.llmMs).toBe(3000);
  });

  it('counts sibling LLM calls separately', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(2_000_000_000),
      }),
      span({
        spanId: 'llm2',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(1_620_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.llmCalls).toBe(2);
    expect(result.metrics.llmMs).toBe(3620);
  });

  it('aggregates tokens from the outermost token-bearing span only', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(2_000_000_000),
        inputTokens: 2849,
        outputTokens: 315,
        totalTokens: 3164,
      }),
      // Nested provider span reporting the same usage — must not double-count.
      span({
        spanId: 'bedrock1',
        parentSpanId: 'llm1',
        name: 'Bedrock Runtime.InvokeModel',
        durationNano: String(1_900_000_000),
        inputTokens: 2849,
        outputTokens: 315,
        totalTokens: 3164,
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.inputTokens).toBe(2849);
    expect(result.metrics.outputTokens).toBe(315);
    expect(result.metrics.totalTokens).toBe(3164);
  });

  it('picks up tokens reported only on a nested provider span', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(2_000_000_000),
      }),
      span({
        spanId: 'bedrock1',
        parentSpanId: 'llm1',
        name: 'Bedrock Runtime.InvokeModel',
        durationNano: String(1_900_000_000),
        inputTokens: 1912,
        outputTokens: 237,
        totalTokens: 2149,
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.inputTokens).toBe(1912);
    expect(result.metrics.outputTokens).toBe(237);
    expect(result.metrics.totalTokens).toBe(2149);
  });

  it('leaves token fields undefined when no span reports usage', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.inputTokens).toBeUndefined();
    expect(result.metrics.outputTokens).toBeUndefined();
    expect(result.metrics.totalTokens).toBeUndefined();
  });

  it('de-duplicates each token field independently across nested spans', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      // Parent reports only the total; the nested provider span carries the split.
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(2_000_000_000),
        totalTokens: 3164,
      }),
      span({
        spanId: 'bedrock1',
        parentSpanId: 'llm1',
        name: 'Bedrock Runtime.InvokeModel',
        durationNano: String(1_900_000_000),
        inputTokens: 2849,
        outputTokens: 315,
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.inputTokens).toBe(2849);
    expect(result.metrics.outputTokens).toBe(315);
    expect(result.metrics.totalTokens).toBe(3164);
  });

  it('marks LLM, tool, and token metrics unavailable when application spans are missing', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans, false);

    assert(result.success);
    expect(result.metrics.endToEndMs).toBe(6000);
    expect(result.metrics.llmCalls).toBeUndefined();
    expect(result.metrics.llmMs).toBeUndefined();
    expect(result.metrics.toolCalls).toBeUndefined();
    expect(result.metrics.toolMs).toBeUndefined();
    expect(result.metrics.totalTokens).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining('application spans unavailable')]);
  });

  it('rounds latency metrics to one decimal place', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        durationNano: String(6_334_894_566),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(3_671_294_691),
      }),
      span({
        spanId: 'tool1',
        parentSpanId: 'root',
        genAiOperation: 'execute_tool',
        name: 'execute_tool weather',
        durationNano: String(2_578_348_746),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.endToEndMs).toBe(6334.9);
    expect(result.metrics.llmMs).toBe(3671.3);
    expect(result.metrics.toolMs).toBe(2578.3);
  });

  it('collects the distinct set of LLM models used in the trace', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat',
        durationNano: String(1_000_000_000),
        responseModel: 'claude-3-5-sonnet-20241022-v2:0',
      }),
      span({
        spanId: 'llm2',
        parentSpanId: 'root',
        genAiOperation: 'chat',
        name: 'chat',
        durationNano: String(1_000_000_000),
        requestModel: 'claude-3-5-sonnet-20241022-v2:0',
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.models).toEqual(['claude-3-5-sonnet-20241022-v2:0']);
  });

  it('captures a model reported only on a nested provider span, preferring response model', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({ spanId: 'llm1', parentSpanId: 'root', genAiOperation: 'chat', name: 'chat', durationNano: String(1e9) }),
      span({
        spanId: 'bedrock1',
        parentSpanId: 'llm1',
        name: 'Bedrock Runtime.InvokeModel',
        durationNano: String(9e8),
        requestModel: 'anthropic.claude-3-haiku',
        responseModel: 'anthropic.claude-3-haiku-20240307-v1:0',
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.models).toEqual(['anthropic.claude-3-haiku-20240307-v1:0']);
  });

  it('leaves models undefined when no span reports a model', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({ spanId: 'llm1', parentSpanId: 'root', genAiOperation: 'chat', name: 'chat', durationNano: String(1e9) }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.models).toBeUndefined();
  });

  it('classifies LangGraph traceloop tool spans', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'tool1',
        parentSpanId: 'root',
        name: 'get_word_frequency.tool',
        traceloopSpanKind: 'tool',
        durationNano: String(1_500_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.toolCalls).toBe(1);
    expect(result.metrics.toolMs).toBe(1500);
  });

  it('classifies OpenInference LLM and tool spans', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'root',
        name: 'ChatBedrock',
        openinferenceSpanKind: 'LLM',
        durationNano: String(2_000_000_000),
      }),
      span({
        spanId: 'tool1',
        parentSpanId: 'root',
        name: 'get_weather',
        openinferenceSpanKind: 'TOOL',
        durationNano: String(1_000_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.llmCalls).toBe(1);
    expect(result.metrics.llmMs).toBe(2000);
    expect(result.metrics.toolCalls).toBe(1);
    expect(result.metrics.toolMs).toBe(1000);
  });

  it('classifies tool spans by .tool name suffix when kind attributes are absent', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'tool1',
        parentSpanId: 'root',
        name: 'get_word_frequency.tool',
        durationNano: String(1_500_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.toolCalls).toBe(1);
  });

  it('counts tool spans and de-duplicates nested tool spans', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'tool1',
        parentSpanId: 'root',
        genAiOperation: 'execute_tool',
        name: 'execute_tool weather',
        durationNano: String(2_850_000_000),
      }),
      span({
        spanId: 'tool1-inner',
        parentSpanId: 'tool1',
        name: 'execute_tool weather',
        durationNano: String(2_700_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.toolCalls).toBe(1);
    expect(result.metrics.toolMs).toBe(2850);
  });

  it('treats spans with unknown parents as top-level', () => {
    const spans = [
      span({
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(6000),
      }),
      span({
        spanId: 'llm1',
        parentSpanId: 'missing-span',
        genAiOperation: 'chat',
        name: 'chat claude-3',
        durationNano: String(1_000_000_000),
      }),
    ];

    const result = aggregateSpans('trace-a', spans);

    assert(result.success);
    expect(result.metrics.llmCalls).toBe(1);
  });
});

describe('buildTraceComparison', () => {
  it('computes absolute and percentage deltas', () => {
    const baseline = metrics({ endToEndMs: 6600, llmMs: 3620, toolMs: 2850, totalTokens: 3164 });
    const candidate = metrics({ traceId: 'trace-b', endToEndMs: 5120, llmMs: 3040, toolMs: 1710, totalTokens: 3000 });

    const { deltas } = buildTraceComparison(baseline, candidate);

    expect(deltas.endToEndMs).toEqual({
      baseline: 6600,
      candidate: 5120,
      delta: -1480,
      deltaPercent: expect.closeTo(-22.42, 1) as number,
    });
    expect(deltas.llmMs.delta).toBe(-580);
    expect(deltas.toolMs.delta).toBe(-1140);
  });

  it('rounds delta and percentage to one decimal place', () => {
    const baseline = metrics({ endToEndMs: 6334.9 });
    const candidate = metrics({ traceId: 'trace-b', endToEndMs: 5701.9 });

    const { deltas } = buildTraceComparison(baseline, candidate);

    expect(deltas.endToEndMs.delta).toBe(-633);
    expect(deltas.endToEndMs.deltaPercent).toBe(-10);
  });

  it('returns null percentage for a zero baseline', () => {
    const baseline = metrics({ toolMs: 0, toolCalls: 0 });
    const candidate = metrics({ traceId: 'trace-b', toolMs: 500, toolCalls: 1 });

    const { deltas } = buildTraceComparison(baseline, candidate);

    expect(deltas.toolMs.delta).toBe(500);
    expect(deltas.toolMs.deltaPercent).toBeNull();
  });

  it('omits values for token metrics missing on both sides', () => {
    const baseline = metrics({});
    const candidate = metrics({ traceId: 'trace-b' });

    const { deltas } = buildTraceComparison(baseline, candidate);

    expect(deltas.totalTokens).toEqual({});
  });

  it('warns when LLM call counts differ', () => {
    const baseline = metrics({ llmCalls: 2 });
    const candidate = metrics({ traceId: 'trace-b', llmCalls: 3 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('LLM call counts differ')]);
  });

  it('warns when tool call counts differ', () => {
    const baseline = metrics({ toolCalls: 1 });
    const candidate = metrics({ traceId: 'trace-b', toolCalls: 0 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('Tool call counts differ')]);
  });

  it('warns when total token usage differs beyond the comparability threshold', () => {
    const baseline = metrics({ totalTokens: 1000 });
    const candidate = metrics({ traceId: 'trace-b', totalTokens: 1500 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('token usage differs')]);
  });

  it('warns when the traces used different models', () => {
    const baseline = metrics({ models: ['claude-3-5-sonnet-20241022-v2:0'] });
    const candidate = metrics({ traceId: 'trace-b', models: ['claude-3-7-sonnet-20250219-v1:0'] });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('Models differ')]);
  });

  it('does not warn when the traces used the same models', () => {
    const baseline = metrics({ models: ['claude-3-5-sonnet-20241022-v2:0'] });
    const candidate = metrics({ traceId: 'trace-b', models: ['claude-3-5-sonnet-20241022-v2:0'] });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([]);
  });

  it('does not warn on matching characteristics', () => {
    const baseline = metrics({ totalTokens: 1000 });
    const candidate = metrics({ traceId: 'trace-b', endToEndMs: 900, totalTokens: 1050 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([]);
  });

  it('warns on input/output token differences beyond the threshold', () => {
    const baseline = metrics({ inputTokens: 1000, outputTokens: 100 });
    const candidate = metrics({ traceId: 'trace-b', inputTokens: 1500, outputTokens: 105 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('Input token usage differs')]);
  });

  it('warns on a zero-to-nonzero token change', () => {
    const baseline = metrics({ totalTokens: 0 });
    const candidate = metrics({ traceId: 'trace-b', totalTokens: 500 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([expect.stringContaining('Total token usage differs')]);
  });

  it('skips count warnings when metrics are unavailable on one side', () => {
    const baseline = metrics({ llmCalls: undefined, llmMs: undefined, toolCalls: undefined, toolMs: undefined });
    const candidate = metrics({ traceId: 'trace-b', llmCalls: 2, toolCalls: 1 });

    const { warnings } = buildTraceComparison(baseline, candidate);

    expect(warnings).toEqual([]);
  });
});

describe('compareTraces', () => {
  afterEach(() => vi.clearAllMocks());

  const options = {
    region: 'us-west-2',
    runtimeId: 'runtime-123',
    baselineTraceId: 'trace-a',
    candidateTraceId: 'trace-b',
  };

  const RESOURCE_ID = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/runtime-123/runtime-endpoint/DEFAULT';
  const SPANS_LOG_GROUP = 'aws/spans';
  const DEFAULT_LOG_GROUP = '/aws/bedrock-agentcore/runtimes/runtime-123-DEFAULT';
  const TEST_LOG_GROUP = '/aws/bedrock-agentcore/runtimes/runtime-123-test';

  function serviceSpan(traceId: string, endMs: number, overrides: Partial<CloudWatchSpanRecord> = {}) {
    return {
      traceId,
      spanId: 'root',
      name: 'POST /invocations',
      kind: 'SERVER',
      startTimeUnixNano: nano(0),
      endTimeUnixNano: nano(endMs),
      cloudResourceId: RESOURCE_ID,
      ...overrides,
    };
  }

  function chatSpan(traceId: string, overrides: Partial<CloudWatchSpanRecord> = {}) {
    return {
      traceId,
      spanId: 'llm1',
      parentSpanId: 'root',
      name: 'chat claude-3',
      genAiOperation: 'chat',
      durationNano: String(2_000_000_000),
      ...overrides,
    };
  }

  /** Configures mockQuerySpanRecords per (traceId, logGroupName); unspecified queries return no spans. */
  function primeSpanQueries(spansByTraceAndGroup: Record<string, Record<string, CloudWatchSpanRecord[]>>) {
    mockQuerySpanRecords.mockImplementation((queryOptions: QuerySpanRecordsOptions) =>
      Promise.resolve({
        success: true,
        spans: spansByTraceAndGroup[queryOptions.traceId]?.[queryOptions.logGroupName] ?? [],
      })
    );
  }

  it('compares two traces and returns metrics, deltas, and warnings', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-a')],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.endToEndMs).toBe(6600);
    expect(result.candidate.endToEndMs).toBe(5120);
    expect(result.baseline.llmCalls).toBe(1);
    expect(result.deltas.endToEndMs.delta).toBe(-1480);
    expect(result.warnings).toEqual([]);
    expect(mockQuerySpanRecords).toHaveBeenCalledWith({
      region: 'us-west-2',
      logGroupName: SPANS_LOG_GROUP,
      traceId: 'trace-a',
      startTime: undefined,
      endTime: undefined,
    });
    expect(mockQuerySpanRecords).toHaveBeenCalledWith({
      region: 'us-west-2',
      logGroupName: DEFAULT_LOG_GROUP,
      traceId: 'trace-b',
      startTime: undefined,
      endTime: undefined,
    });
  });

  it('fetches application spans from the endpoint-specific log group per trace', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600, { endpointName: 'test' })],
        [TEST_LOG_GROUP]: [chatSpan('trace-a')],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.llmCalls).toBe(1);
    expect(result.candidate.llmCalls).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(mockQuerySpanRecords).toHaveBeenCalledWith(expect.objectContaining({ logGroupName: TEST_LOG_GROUP }));
  });

  it('scopes ownership, endpoint, and metrics to spans matching the runtime id', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [
          // A distributed trace: another runtime's invocation span appears first
          // with a different endpoint — it must not drive endpoint selection or timing.
          serviceSpan('trace-a', 9000, {
            spanId: 'root-other',
            cloudResourceId: undefined,
            agentId: 'other-runtime',
            endpointName: 'DEFAULT',
          }),
          serviceSpan('trace-a', 6600, {
            cloudResourceId: undefined,
            agentId: 'runtime-123',
            endpointName: 'test',
          }),
        ],
        [TEST_LOG_GROUP]: [chatSpan('trace-a')],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.endToEndMs).toBe(6600);
    expect(result.baseline.spanCount).toBe(2);
    expect(mockQuerySpanRecords).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-a', logGroupName: TEST_LOG_GROUP })
    );
  });

  it('rejects a trace whose agent ids all belong to other runtimes', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [
          serviceSpan('trace-a', 6600, { cloudResourceId: undefined, agentId: 'other-runtime' }),
        ],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('belongs to a different runtime');
  });

  it('merges duplicate span records preferring defined runtime log fields', async () => {
    primeSpanQueries({
      'trace-a': {
        // Shared log group has a partial record: no tokens, no parent link.
        [SPANS_LOG_GROUP]: [
          serviceSpan('trace-a', 6600),
          chatSpan('trace-a', {
            durationNano: undefined,
            genAiOperation: undefined,
            parentSpanId: undefined,
          }),
        ],
        // Runtime log group has the richer record for the same span ID.
        [DEFAULT_LOG_GROUP]: [
          chatSpan('trace-a', { inputTokens: 2849, outputTokens: 315, totalTokens: 3164 }),
        ],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b', { inputTokens: 2500, outputTokens: 300, totalTokens: 2800 })],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.spanCount).toBe(2);
    expect(result.baseline.llmCalls).toBe(1);
    expect(result.baseline.llmMs).toBe(2000);
    expect(result.baseline.totalTokens).toBe(3164);
    expect(result.baseline.inputTokens).toBe(2849);
  });

  it('rejects a trace that belongs to a different runtime', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [
          serviceSpan('trace-a', 6600, {
            cloudResourceId: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/other-runtime/x',
          }),
        ],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('belongs to a different runtime');
    expect(result.error.message).toContain('trace-a');
  });

  it('reports metrics as unavailable instead of zero when application spans are missing', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600)],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.llmCalls).toBeUndefined();
    expect(result.baseline.toolCalls).toBeUndefined();
    expect(result.deltas.llmMs.delta).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining('application spans unavailable')]);
  });

  it('treats a missing endpoint log group as unavailable application spans', async () => {
    mockQuerySpanRecords.mockImplementation((queryOptions: QuerySpanRecordsOptions) => {
      if (queryOptions.logGroupName === SPANS_LOG_GROUP) {
        return Promise.resolve({
          success: true,
          spans: [serviceSpan(queryOptions.traceId, queryOptions.traceId === 'trace-a' ? 6600 : 5120)],
        });
      }
      return Promise.resolve({ success: false, error: new ResourceNotFoundError('Log group not found') });
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.llmCalls).toBeUndefined();
    expect(result.candidate.llmCalls).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringContaining('trace-a'),
      expect.stringContaining('trace-b'),
    ]);
  });

  it('de-duplicates spans that appear in both log groups', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600), chatSpan('trace-a')],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-a')],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.spanCount).toBe(2);
    expect(result.baseline.llmCalls).toBe(1);
  });

  it('fails clearly when the baseline trace has no spans', async () => {
    primeSpanQueries({
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('baseline trace trace-a');
  });

  it('fails clearly when the candidate trace has no spans', async () => {
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-a')],
      },
    });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('candidate trace trace-b');
  });

  it('propagates fetch failures', async () => {
    mockQuerySpanRecords.mockImplementation((queryOptions: QuerySpanRecordsOptions) => {
      if (queryOptions.traceId === 'trace-a' && queryOptions.logGroupName === SPANS_LOG_GROUP) {
        return Promise.resolve({ success: false, error: new Error('Query failed') });
      }
      return Promise.resolve({ success: true, spans: [serviceSpan('trace-b', 5120)] });
    });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toBe('Query failed');
  });

  it('produces the documented JSON contract shape', async () => {
    function toolSpan(traceId: string, durationNano: string) {
      return {
        traceId,
        spanId: 'tool1',
        parentSpanId: 'root',
        name: 'execute_tool weather',
        genAiOperation: 'execute_tool',
        durationNano,
      };
    }
    primeSpanQueries({
      'trace-a': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-a', 6600)],
        [DEFAULT_LOG_GROUP]: [
          chatSpan('trace-a', { inputTokens: 2849, outputTokens: 315, totalTokens: 3164 }),
          toolSpan('trace-a', String(2_850_000_000)),
        ],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 5120)],
        [DEFAULT_LOG_GROUP]: [
          chatSpan('trace-b', {
            durationNano: String(1_710_000_000),
            inputTokens: 2500,
            outputTokens: 300,
            totalTokens: 2800,
          }),
          toolSpan('trace-b', String(1_000_000_000)),
        ],
      },
    });

    const result = await compareTraces(options);

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      success: true,
      baseline: {
        traceId: 'trace-a',
        spanCount: 3,
        endToEndMs: 6600,
        timingSource: 'invocation-span',
        llmMs: 2000,
        llmCalls: 1,
        toolMs: 2850,
        toolCalls: 1,
        inputTokens: 2849,
        outputTokens: 315,
        totalTokens: 3164,
      },
      candidate: {
        traceId: 'trace-b',
        spanCount: 3,
        endToEndMs: 5120,
        timingSource: 'invocation-span',
        llmMs: 1710,
        llmCalls: 1,
        toolMs: 1000,
        toolCalls: 1,
        inputTokens: 2500,
        outputTokens: 300,
        totalTokens: 2800,
      },
      deltas: {
        endToEndMs: { baseline: 6600, candidate: 5120, delta: -1480, deltaPercent: expect.closeTo(-22.4, 1) as number },
        llmMs: { baseline: 2000, candidate: 1710, delta: -290, deltaPercent: expect.closeTo(-14.5, 1) as number },
        toolMs: { baseline: 2850, candidate: 1000, delta: -1850, deltaPercent: expect.closeTo(-64.9, 1) as number },
        llmCalls: { baseline: 1, candidate: 1, delta: 0, deltaPercent: 0 },
        toolCalls: { baseline: 1, candidate: 1, delta: 0, deltaPercent: 0 },
        inputTokens: { baseline: 2849, candidate: 2500, delta: -349, deltaPercent: expect.closeTo(-12.2, 1) as number },
        outputTokens: { baseline: 315, candidate: 300, delta: -15, deltaPercent: expect.closeTo(-4.8, 1) as number },
        totalTokens: { baseline: 3164, candidate: 2800, delta: -364, deltaPercent: expect.closeTo(-11.5, 1) as number },
      },
      warnings: [],
    });
  });

  it('surfaces per-trace fallback-timing warnings', async () => {
    primeSpanQueries({
      'trace-a': {
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-a', { startTimeUnixNano: nano(0), endTimeUnixNano: nano(1000) })],
      },
      'trace-b': {
        [SPANS_LOG_GROUP]: [serviceSpan('trace-b', 1000)],
        [DEFAULT_LOG_GROUP]: [chatSpan('trace-b')],
      },
    });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.warnings).toEqual([expect.stringContaining('trace-a')]);
  });
});
