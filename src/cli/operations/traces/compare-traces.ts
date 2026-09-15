import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { runtimeLogGroup } from '../../aws/cloudwatch';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import { SPANS_LOG_GROUP } from './constants';
import { querySpanRecords } from './get-trace';
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
// Framework span-kind attributes: Traceloop/OpenLLMetry (LangGraph et al.) and OpenInference.
const OPENINFERENCE_LLM_KINDS = new Set(['llm', 'embedding']);
// Fallbacks for spans that predate the operation attribute (framework/provider span names).
// The `.tool` suffix matches Traceloop-instrumented tool spans (e.g. "get_word_frequency.tool").
const LLM_NAME_PATTERN = /^chat\b|^invoke_model\b|^text_completion\b|^generate_content\b|InvokeModel|^Model invoke$/i;
const TOOL_NAME_PATTERN = /^execute_tool\b|^Tool: |\.tool$/i;
const INVOCATION_PATH = '/invocations';
// Relative per-field token difference above which the traces are flagged as possibly incomparable.
const TOKEN_COMPARABILITY_THRESHOLD = 0.2;
// Extracts the runtime resource ID from resource.attributes.cloud.resource_id (".../runtime/<id>/...").
const RUNTIME_RESOURCE_ID_PATTERN = /runtime\/([^/]+)/;

const TOKEN_FIELDS = [
  ['inputTokens', 'Input token'],
  ['outputTokens', 'Output token'],
  ['totalTokens', 'Total token'],
] as const;

type SpanCategory = 'llm' | 'tool' | 'other';

function categorize(span: CloudWatchSpanRecord): SpanCategory {
  const operation = span.genAiOperation?.toLowerCase();
  if (operation && LLM_OPERATIONS.has(operation)) return 'llm';
  if (operation && TOOL_OPERATIONS.has(operation)) return 'tool';
  if (span.traceloopSpanKind?.toLowerCase() === 'tool') return 'tool';
  const openinferenceKind = span.openinferenceSpanKind?.toLowerCase();
  if (openinferenceKind && OPENINFERENCE_LLM_KINDS.has(openinferenceKind)) return 'llm';
  if (openinferenceKind === 'tool') return 'tool';
  const name = span.name ?? '';
  if (LLM_NAME_PATTERN.test(name)) return 'llm';
  if (TOOL_NAME_PATTERN.test(name)) return 'tool';
  return 'other';
}

/**
 * Rounds to one decimal place. Applied to latency (ms) and percentage fields at
 * the output boundary so the JSON contract stays stable — sub-millisecond
 * precision from nanosecond conversion is measurement noise, and rounding
 * removes float-arithmetic artifacts (e.g. 2847.0795900000003) that would make
 * two otherwise-equal runs diff in CI.
 */
function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
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
  if (!name.includes(INVOCATION_PATH)) return false;
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

/**
 * Computes latency and token metrics for a single trace.
 *
 * Nested spans of the same category are de-duplicated via parent links: a
 * framework LLM span and its nested provider client span (e.g. a Strands chat
 * span wrapping a Bedrock InvokeModel span) count as one model call. Each token
 * field is likewise summed only from the outermost span reporting that field,
 * so complementary parent/child fields (total on one, input/output on the
 * other) are all preserved.
 *
 * When `appSpansAvailable` is false, only end-to-end timing is computed and
 * LLM/tool/token metrics stay undefined — absent application spans mean the
 * data is unavailable, not zero.
 */
export function aggregateSpans(
  traceId: string,
  spans: CloudWatchSpanRecord[],
  appSpansAvailable = true
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
  endToEndMs = roundTo1(endToEndMs);

  if (!appSpansAvailable) {
    warnings.push(
      `Trace ${traceId}: application spans unavailable (only service spans found); LLM, tool, and token metrics were not computed`
    );
    return {
      success: true,
      metrics: { traceId, spanCount: spans.length, endToEndMs, timingSource },
      warnings,
    };
  }

  const topLevelOfCategory = (category: SpanCategory): CloudWatchSpanRecord[] =>
    spans.filter(
      span =>
        categorize(span) === category && !hasAncestorMatching(span, byId, ancestor => categorize(ancestor) === category)
    );

  const llmSpans = topLevelOfCategory('llm');
  const toolSpans = topLevelOfCategory('tool');

  // Collect the distinct LLM models seen anywhere in the trace. The model
  // attribute may sit on the framework span or its nested provider span, so
  // scan every span; prefer the response model (what actually served) over the
  // requested model.
  const models = [
    ...new Set(
      spans.map(span => span.responseModel ?? span.requestModel).filter((model): model is string => model !== undefined)
    ),
  ].sort();

  // De-duplicate each token field independently: a span's field counts only if
  // no ancestor reports that same field, so a parent carrying totalTokens does
  // not suppress a child carrying the input/output split.
  const sumTokenField = (field: 'inputTokens' | 'outputTokens' | 'totalTokens'): number | undefined =>
    sumDefined(
      spans.filter(
        span => span[field] !== undefined && !hasAncestorMatching(span, byId, ancestor => ancestor[field] !== undefined)
      ),
      span => span[field]
    );

  return {
    success: true,
    metrics: {
      traceId,
      spanCount: spans.length,
      endToEndMs,
      timingSource,
      llmMs: roundTo1(sumDefined(llmSpans, spanDurationMs) ?? 0),
      llmCalls: llmSpans.length,
      toolMs: roundTo1(sumDefined(toolSpans, spanDurationMs) ?? 0),
      toolCalls: toolSpans.length,
      inputTokens: sumTokenField('inputTokens'),
      outputTokens: sumTokenField('outputTokens'),
      totalTokens: sumTokenField('totalTokens'),
      models: models.length > 0 ? models : undefined,
    },
    warnings,
  };
}

function metricDelta(baseline?: number, candidate?: number): MetricDelta {
  const entry: MetricDelta = {};
  if (baseline !== undefined) entry.baseline = baseline;
  if (candidate !== undefined) entry.candidate = candidate;
  if (baseline !== undefined && candidate !== undefined) {
    entry.delta = roundTo1(candidate - baseline);
    entry.deltaPercent = baseline > 0 ? roundTo1(((candidate - baseline) / baseline) * 100) : null;
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
  if (baseline.models && candidate.models && baseline.models.join(',') !== candidate.models.join(',')) {
    warnings.push(
      `Models differ (baseline ${baseline.models.join(', ')}, candidate ${candidate.models.join(', ')}); traces may not be directly comparable`
    );
  }
  if (baseline.llmCalls !== undefined && candidate.llmCalls !== undefined && baseline.llmCalls !== candidate.llmCalls) {
    warnings.push(
      `LLM call counts differ (baseline ${baseline.llmCalls}, candidate ${candidate.llmCalls}); traces may not be directly comparable`
    );
  }
  if (
    baseline.toolCalls !== undefined &&
    candidate.toolCalls !== undefined &&
    baseline.toolCalls !== candidate.toolCalls
  ) {
    warnings.push(
      `Tool call counts differ (baseline ${baseline.toolCalls}, candidate ${candidate.toolCalls}); traces may not be directly comparable`
    );
  }
  for (const [field, label] of TOKEN_FIELDS) {
    const baselineTokens = baseline[field];
    const candidateTokens = candidate[field];
    if (baselineTokens === undefined || candidateTokens === undefined) continue;
    if (baselineTokens > 0) {
      const relativeDiff = Math.abs(candidateTokens - baselineTokens) / baselineTokens;
      if (relativeDiff > TOKEN_COMPARABILITY_THRESHOLD) {
        warnings.push(
          `${label} usage differs by ${Math.round(relativeDiff * 100)}% (baseline ${baselineTokens}, candidate ${candidateTokens}); traces may not be directly comparable`
        );
      }
    } else if (candidateTokens > 0) {
      warnings.push(
        `${label} usage differs (baseline ${baselineTokens}, candidate ${candidateTokens}); traces may not be directly comparable`
      );
    }
  }

  return { deltas, warnings };
}

/** Runtime identity of a span, from `aws.agent.id` or parsed from `cloud.resource_id`. */
function spanRuntimeId(span: CloudWatchSpanRecord): string | undefined {
  if (span.agentId) return span.agentId;
  if (span.cloudResourceId) return RUNTIME_RESOURCE_ID_PATTERN.exec(span.cloudResourceId)?.[1];
  return undefined;
}

/** Merges two records for the same span ID; `primary`'s defined fields win. */
function mergeSpanRecords(primary: CloudWatchSpanRecord, fallback: CloudWatchSpanRecord): CloudWatchSpanRecord {
  const merged: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as CloudWatchSpanRecord;
}

/**
 * Fetches all span records for one trace: service-side spans from the shared
 * `aws/spans` log group, then application spans from the endpoint-specific
 * runtime log group.
 *
 * A distributed trace may span multiple runtimes, so everything is scoped to
 * the selected runtime: spans identified (via `aws.agent.id` or
 * `cloud.resource_id`) as belonging to other runtimes are excluded from
 * metrics, the endpoint is derived only from this runtime's spans (baseline
 * and candidate may use different endpoints), and a trace whose identified
 * spans all belong to other runtimes is rejected rather than silently
 * producing empty metrics. Duplicate records for the same span ID are merged
 * field by field, preferring defined runtime-log values.
 */
async function fetchComparisonSpans(
  region: string,
  runtimeId: string,
  traceId: string,
  startTime?: number,
  endTime?: number
): Promise<Result<{ spans: CloudWatchSpanRecord[]; appSpansAvailable: boolean }>> {
  const queryOpts = { region, traceId, startTime, endTime };

  const serviceResult = await querySpanRecords({ ...queryOpts, logGroupName: SPANS_LOG_GROUP });
  let serviceSpans: CloudWatchSpanRecord[] = [];
  if (serviceResult.success) {
    serviceSpans = serviceResult.spans;
  } else if (!(serviceResult.error instanceof ResourceNotFoundError)) {
    return serviceResult;
  }

  const identified = serviceSpans.filter(span => spanRuntimeId(span) !== undefined);
  const matched = identified.filter(span => spanRuntimeId(span) === runtimeId);
  if (identified.length > 0 && matched.length === 0) {
    return {
      success: false,
      error: new ValidationError(`Trace ${traceId} belongs to a different runtime (expected ${runtimeId})`),
    };
  }

  // Keep this runtime's spans plus spans with no runtime identity; drop other runtimes' spans.
  const scopedServiceSpans = serviceSpans.filter(span => {
    const owner = spanRuntimeId(span);
    return owner === undefined || owner === runtimeId;
  });

  const endpointSource = matched.length > 0 ? matched : scopedServiceSpans;
  const endpointName = endpointSource.find(span => span.endpointName)?.endpointName ?? DEFAULT_ENDPOINT_NAME;

  const appResult = await querySpanRecords({ ...queryOpts, logGroupName: runtimeLogGroup(runtimeId, endpointName) });
  let appSpans: CloudWatchSpanRecord[] = [];
  if (appResult.success) {
    appSpans = appResult.spans;
  } else if (!(appResult.error instanceof ResourceNotFoundError)) {
    return appResult;
  }

  const merged = new Map<string, CloudWatchSpanRecord>();
  for (const span of scopedServiceSpans) {
    merged.set(span.spanId, span);
  }
  for (const span of appSpans) {
    const existing = merged.get(span.spanId);
    merged.set(span.spanId, existing ? mergeSpanRecords(span, existing) : span);
  }

  // Application spans may arrive via the runtime log group or (with transaction
  // search) directly in aws/spans; either way, anything beyond the service-side
  // invocation span counts as application data.
  const appSpansAvailable = appSpans.length > 0 || scopedServiceSpans.some(span => !isInvocationSpan(span));

  return { success: true, spans: [...merged.values()], appSpansAvailable };
}

/**
 * Fetches span records for two traces from CloudWatch and compares their
 * latency and token metrics.
 */
export async function compareTraces(options: CompareTracesOptions): Promise<CompareTracesResult> {
  const { region, runtimeId, baselineTraceId, candidateTraceId, startTime, endTime } = options;

  const [baselineFetch, candidateFetch] = await Promise.all([
    fetchComparisonSpans(region, runtimeId, baselineTraceId, startTime, endTime),
    fetchComparisonSpans(region, runtimeId, candidateTraceId, startTime, endTime),
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

  const baselineAgg = aggregateSpans(baselineTraceId, baselineFetch.spans, baselineFetch.appSpansAvailable);
  if (!baselineAgg.success) return baselineAgg;
  const candidateAgg = aggregateSpans(candidateTraceId, candidateFetch.spans, candidateFetch.appSpansAvailable);
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
