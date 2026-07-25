import { aggregateSpans, buildTraceComparison, compareTraces } from '../compare-traces';
import type { CloudWatchSpanRecord, TraceMetrics } from '../types';
import assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFetchSpans } = vi.hoisted(() => ({
  mockFetchSpans: vi.fn(),
}));

vi.mock('../get-trace', () => ({
  fetchSpans: (...args: unknown[]) => mockFetchSpans(...args),
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

  it('does not warn on matching characteristics', () => {
    const baseline = metrics({ totalTokens: 1000 });
    const candidate = metrics({ traceId: 'trace-b', endToEndMs: 900, totalTokens: 1050 });

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

  function invocationTrace(traceId: string, endMs: number): CloudWatchSpanRecord[] {
    return [
      {
        traceId,
        spanId: 'root',
        name: 'POST /invocations',
        kind: 'SERVER',
        startTimeUnixNano: nano(0),
        endTimeUnixNano: nano(endMs),
      },
    ];
  }

  it('compares two traces and returns metrics, deltas, and warnings', async () => {
    mockFetchSpans
      .mockResolvedValueOnce({ success: true, spans: invocationTrace('trace-a', 6600) })
      .mockResolvedValueOnce({ success: true, spans: invocationTrace('trace-b', 5120) });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.baseline.endToEndMs).toBe(6600);
    expect(result.candidate.endToEndMs).toBe(5120);
    expect(result.deltas.endToEndMs.delta).toBe(-1480);
    expect(result.warnings).toEqual([]);
    expect(mockFetchSpans).toHaveBeenCalledWith('us-west-2', 'runtime-123', 'trace-a', undefined, undefined);
    expect(mockFetchSpans).toHaveBeenCalledWith('us-west-2', 'runtime-123', 'trace-b', undefined, undefined);
  });

  it('fails clearly when the baseline trace has no spans', async () => {
    mockFetchSpans
      .mockResolvedValueOnce({ success: true, spans: [] })
      .mockResolvedValueOnce({ success: true, spans: invocationTrace('trace-b', 5120) });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('baseline trace trace-a');
  });

  it('fails clearly when the candidate trace has no spans', async () => {
    mockFetchSpans
      .mockResolvedValueOnce({ success: true, spans: invocationTrace('trace-a', 6600) })
      .mockResolvedValueOnce({ success: true, spans: [] });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toContain('candidate trace trace-b');
  });

  it('propagates fetch failures', async () => {
    mockFetchSpans
      .mockResolvedValueOnce({ success: false, error: new Error('Query failed') })
      .mockResolvedValueOnce({ success: true, spans: invocationTrace('trace-b', 5120) });

    const result = await compareTraces(options);

    assert(!result.success);
    expect(result.error.message).toBe('Query failed');
  });

  it('surfaces per-trace fallback-timing warnings', async () => {
    mockFetchSpans
      .mockResolvedValueOnce({
        success: true,
        spans: [
          {
            traceId: 'trace-a',
            spanId: 'llm1',
            name: 'chat claude-3',
            genAiOperation: 'chat',
            startTimeUnixNano: nano(0),
            endTimeUnixNano: nano(1000),
          },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        spans: [
          ...invocationTrace('trace-b', 1000),
          {
            traceId: 'trace-b',
            spanId: 'llm1',
            parentSpanId: 'root',
            name: 'chat claude-3',
            genAiOperation: 'chat',
            startTimeUnixNano: nano(0),
            endTimeUnixNano: nano(900),
          },
        ],
      });

    const result = await compareTraces(options);

    assert(result.success);
    expect(result.warnings).toEqual([expect.stringContaining('trace-a')]);
  });
});
