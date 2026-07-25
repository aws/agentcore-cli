import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { fetchSpans } from './get-trace';
import type {
  CloudWatchSpanRecord,
  CompareTracesOptions,
  CompareTracesResult,
  MetricDelta,
  TraceComparisonDeltas,
  TraceMetrics,
} from './types';

// OTel GenAI semantic-convention operation names (attributes.gen_ai.operation.name).
const LLM_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings', 'invoke_model']);
const TOOL_OPERATIONS = new Set(['execute_tool']);
// Fallbacks for spans that predate the operation attribute (framework/provider span names).
const LLM_NAME_PATTERN = /^chat\b|^invoke_model\b|^text_completion\b|^generate_content\b|InvokeModel|^Model invoke$/i;
const TOOL_NAME_PATTERN = /^execute_tool\b|^Tool: /i;
const INVOCATION_NAME_PATTERN = /\/invocations/;
// Relative total-token difference above which the traces are flagged as possibly incomparable.
const TOKEN_COMPARABILITY_THRESHOLD = 0.2;

type SpanCategory = 'llm' | 'tool' | 'other';

function categorize(span: CloudWatchSpanRecord): SpanCategory {
  const operation = span.genAiOperation?.toLowerCase();
  if (operation && LLM_OPERATIONS.has(operation)) return 'llm';
  if (operation && TOOL_OPERATIONS.has(operation)) return 'tool';
  const name = span.name ?? '';
  if (LLM_NAME_PATTERN.test(name)) return 'llm';
  if (TOOL_NAME_PATTERN.test(name)) return 'tool';
  return 'other';
}

function nanoToMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ns = Number(value);
  if (!Number.isFinite(ns)) return undefined;
  return ns / 1e6;
}

function spanDurationMs(span: CloudWatchSpanRecord): number | undefined {
  const duration = nanoToMs(span.durationNano);
  if (duration !== undefined) return duration;
  const start = nanoToMs(span.startTimeUnixNano);
  const end = nanoToMs(span.endTimeUnixNano);
  if (start === undefined || end === undefined) return undefined;
  return end - start;
}

function isInvocationSpan(span: CloudWatchSpanRecord): boolean {
  const name = span.name ?? '';
  if (!INVOCATION_NAME_PATTERN.test(name)) return false;
  // CloudWatch parent/child data can be incomplete, so match kind when present
  // and fall back to the conventional server-span name otherwise.
  if (span.kind) return span.kind.toUpperCase().includes('SERVER');
  return name.startsWith('POST ');
}

/**
 * Walks the parent chain looking for an ancestor matching the predicate.
 * Unknown parents end the walk (parent links may be incomplete); a visited
 * set guards against cyclic references in malformed data.
 */
function hasAncestorMatching(
  span: CloudWatchSpanRecord,
  byId: Map<string, CloudWatchSpanRecord>,
  predicate: (ancestor: CloudWatchSpanRecord) => boolean
): boolean {
  const visited = new Set<string>([span.spanId]);
  let parentId = span.parentSpanId;
  while (parentId && !visited.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (predicate(parent)) return true;
    visited.add(parentId);
    parentId = parent.parentSpanId;
  }
  return false;
}

function sumDefined(
  spans: CloudWatchSpanRecord[],
  pick: (span: CloudWatchSpanRecord) => number | undefined
): number | undefined {
  let total: number | undefined;
  for (const span of spans) {
    const value = pick(span);
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

function hasTokenUsage(span: CloudWatchSpanRecord): boolean {
  return span.inputTokens !== undefined || span.outputTokens !== undefined || span.totalTokens !== undefined;
}

/**
 * Computes latency and token metrics for a single trace.
 *
 * Nested spans of the same category are de-duplicated via parent links: a
 * framework LLM span and its nested provider client span (e.g. a Strands chat
 * span wrapping a Bedrock InvokeModel span) count as one model call. Token
 * usage is likewise summed only from the outermost token-bearing spans.
 */
export function aggregateSpans(
  traceId: string,
  spans: CloudWatchSpanRecord[]
): Result<{ metrics: TraceMetrics; warnings: string[] }> {
  const warnings: string[] = [];
  const byId = new Map(spans.map(span => [span.spanId, span]));

  let endToEndMs: number | undefined;
  let timingSource: TraceMetrics['timingSource'] = 'invocation-span';

  const invocationSpan = spans
    .filter(span => isInvocationSpan(span) && spanDurationMs(span) !== undefined)
    .sort((a, b) => (nanoToMs(a.startTimeUnixNano) ?? Infinity) - (nanoToMs(b.startTimeUnixNano) ?? Infinity))[0];

  if (invocationSpan) {
    endToEndMs = spanDurationMs(invocationSpan);
  } else {
    const starts = spans.map(span => nanoToMs(span.startTimeUnixNano)).filter((v): v is number => v !== undefined);
    const ends = spans.map(span => nanoToMs(span.endTimeUnixNano)).filter((v): v is number => v !== undefined);
    if (starts.length > 0 && ends.length > 0) {
      endToEndMs = Math.max(...ends) - Math.min(...starts);
      timingSource = 'span-envelope';
      warnings.push(
        `Trace ${traceId}: end-to-end latency derived from earliest/latest span times (no POST /invocations server span found)`
      );
    }
  }

  if (endToEndMs === undefined) {
    return { success: false, error: new ValidationError(`Trace ${traceId} has no spans with timing data`) };
  }

  const topLevelOfCategory = (category: SpanCategory): CloudWatchSpanRecord[] =>
    spans.filter(
      span =>
        categorize(span) === category && !hasAncestorMatching(span, byId, ancestor => categorize(ancestor) === category)
    );

  const llmSpans = topLevelOfCategory('llm');
  const toolSpans = topLevelOfCategory('tool');
  const tokenSpans = spans.filter(
    span => hasTokenUsage(span) && !hasAncestorMatching(span, byId, hasTokenUsage)
  );

  return {
    success: true,
    metrics: {
      traceId,
      spanCount: spans.length,
      endToEndMs,
      timingSource,
      llmMs: sumDefined(llmSpans, spanDurationMs) ?? 0,
      llmCalls: llmSpans.length,
      toolMs: sumDefined(toolSpans, spanDurationMs) ?? 0,
      toolCalls: toolSpans.length,
      inputTokens: sumDefined(tokenSpans, span => span.inputTokens),
      outputTokens: sumDefined(tokenSpans, span => span.outputTokens),
      totalTokens: sumDefined(tokenSpans, span => span.totalTokens),
    },
    warnings,
  };
}

function metricDelta(baseline?: number, candidate?: number): MetricDelta {
  const entry: MetricDelta = {};
  if (baseline !== undefined) entry.baseline = baseline;
  if (candidate !== undefined) entry.candidate = candidate;
  if (baseline !== undefined && candidate !== undefined) {
    entry.delta = candidate - baseline;
    entry.deltaPercent = baseline > 0 ? ((candidate - baseline) / baseline) * 100 : null;
  }
  return entry;
}

/**
 * Builds per-metric deltas and comparability warnings for two traces.
 * Warnings flag observable differences (call counts, token usage) — the CLI
 * cannot prove the two invocations ran equivalent workloads.
 */
export function buildTraceComparison(
  baseline: TraceMetrics,
  candidate: TraceMetrics
): { deltas: TraceComparisonDeltas; warnings: string[] } {
  const deltas: TraceComparisonDeltas = {
    endToEndMs: metricDelta(baseline.endToEndMs, candidate.endToEndMs),
    llmMs: metricDelta(baseline.llmMs, candidate.llmMs),
    toolMs: metricDelta(baseline.toolMs, candidate.toolMs),
    llmCalls: metricDelta(baseline.llmCalls, candidate.llmCalls),
    toolCalls: metricDelta(baseline.toolCalls, candidate.toolCalls),
    inputTokens: metricDelta(baseline.inputTokens, candidate.inputTokens),
    outputTokens: metricDelta(baseline.outputTokens, candidate.outputTokens),
    totalTokens: metricDelta(baseline.totalTokens, candidate.totalTokens),
  };

  const warnings: string[] = [];
  if (baseline.llmCalls !== candidate.llmCalls) {
    warnings.push(
      `LLM call counts differ (baseline ${baseline.llmCalls}, candidate ${candidate.llmCalls}); traces may not be directly comparable`
    );
  }
  if (baseline.toolCalls !== candidate.toolCalls) {
    warnings.push(
      `Tool call counts differ (baseline ${baseline.toolCalls}, candidate ${candidate.toolCalls}); traces may not be directly comparable`
    );
  }
  if (baseline.totalTokens !== undefined && candidate.totalTokens !== undefined && baseline.totalTokens > 0) {
    const relativeDiff = Math.abs(candidate.totalTokens - baseline.totalTokens) / baseline.totalTokens;
    if (relativeDiff > TOKEN_COMPARABILITY_THRESHOLD) {
      warnings.push(
        `Total token usage differs by ${Math.round(relativeDiff * 100)}% (baseline ${baseline.totalTokens}, candidate ${candidate.totalTokens}); traces may not be directly comparable`
      );
    }
  }

  return { deltas, warnings };
}

/**
 * Fetches span records for two traces from CloudWatch and compares their
 * latency and token metrics.
 */
export async function compareTraces(options: CompareTracesOptions): Promise<CompareTracesResult> {
  const { region, runtimeId, baselineTraceId, candidateTraceId, startTime, endTime } = options;

  const [baselineFetch, candidateFetch] = await Promise.all([
    fetchSpans(region, runtimeId, baselineTraceId, startTime, endTime),
    fetchSpans(region, runtimeId, candidateTraceId, startTime, endTime),
  ]);

  if (!baselineFetch.success) return baselineFetch;
  if (!candidateFetch.success) return candidateFetch;

  for (const [role, traceId, spans] of [
    ['baseline', baselineTraceId, baselineFetch.spans],
    ['candidate', candidateTraceId, candidateFetch.spans],
  ] as const) {
    if (spans.length === 0) {
      return {
        success: false,
        error: new ResourceNotFoundError(
          `No spans found for ${role} trace ${traceId}. Traces may take 2-3 minutes to appear in CloudWatch.`
        ),
      };
    }
  }

  const baselineAgg = aggregateSpans(baselineTraceId, baselineFetch.spans);
  if (!baselineAgg.success) return baselineAgg;
  const candidateAgg = aggregateSpans(candidateTraceId, candidateFetch.spans);
  if (!candidateAgg.success) return candidateAgg;

  const comparison = buildTraceComparison(baselineAgg.metrics, candidateAgg.metrics);

  return {
    success: true,
    baseline: baselineAgg.metrics,
    candidate: candidateAgg.metrics,
    deltas: comparison.deltas,
    warnings: [...baselineAgg.warnings, ...candidateAgg.warnings, ...comparison.warnings],
  };
}
