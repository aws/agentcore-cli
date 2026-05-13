import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import { runInsightsQuery } from './insights-query';
import type {
  CloudWatchSpanRecord,
  CloudWatchTraceRecord,
  FetchTraceRecordsOptions,
  FetchTraceRecordsResult,
  GetTraceOptions,
  GetTraceResult,
} from './types';
import fs from 'node:fs';
import path from 'node:path';

const SPANS_LOG_GROUP = 'aws/spans';
const TRACE_ID_PATTERN = /^[a-fA-F0-9-]+$/;

function runtimeLogGroup(runtimeId: string): string {
  return `/aws/bedrock-agentcore/runtimes/${runtimeId}-${DEFAULT_ENDPOINT_NAME}`;
}

async function fetchSpans(
  region: string,
  traceId: string,
  startTime?: number,
  endTime?: number
): Promise<Result<{ spans: CloudWatchSpanRecord[] }>> {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    return {
      success: false,
      error: new ValidationError('Invalid trace ID format. Expected a hex string (e.g., abc123def456).'),
    };
  }

  const result = await runInsightsQuery({
    region,
    logGroupName: SPANS_LOG_GROUP,
    startTime,
    endTime,
    queryString: `fields traceId, spanId, parentSpanId, name, kind,
  startTimeUnixNano, endTimeUnixNano, durationNano,
  status.code as statusCode,
  resource.attributes.service.name as serviceName,
  attributes.gen_ai.usage.input_tokens as inputTokens,
  attributes.gen_ai.usage.output_tokens as outputTokens,
  attributes.gen_ai.usage.total_tokens as totalTokens,
  attributes.http.status_code as httpStatusCode,
  attributes.session.id as sessionId
| filter ispresent(traceId) and ispresent(resource.attributes.service.name)
| filter resource.attributes.aws.service.type = "gen_ai_agent"
| filter traceId = '${traceId}'
| sort startTimeUnixNano asc`,
  });

  if (!result.success) return { success: false, error: result.error };

  const spans: CloudWatchSpanRecord[] = result.rows
    .filter(row => row.traceId && row.spanId)
    .map(row => ({
      traceId: row.traceId!,
      spanId: row.spanId!,
      parentSpanId: row.parentSpanId ?? undefined,
      name: row.name ?? undefined,
      kind: row.kind ?? undefined,
      startTimeUnixNano: row.startTimeUnixNano ?? undefined,
      endTimeUnixNano: row.endTimeUnixNano ?? undefined,
      durationNano: row.durationNano ?? undefined,
      statusCode: row.statusCode ?? undefined,
      serviceName: row.serviceName ?? undefined,
      inputTokens: row.inputTokens ? Number(row.inputTokens) : undefined,
      outputTokens: row.outputTokens ? Number(row.outputTokens) : undefined,
      totalTokens: row.totalTokens ? Number(row.totalTokens) : undefined,
      httpStatusCode: row.httpStatusCode ? Number(row.httpStatusCode) : undefined,
      sessionId: row.sessionId ?? undefined,
    }));

  return { success: true, spans };
}

/**
 * Fetches trace records from CloudWatch Logs Insights for a given trace ID.
 * Returns typed records for the web UI API. Use `getTrace()` to write raw
 * results to a JSON file on disk.
 */
export async function fetchTraceRecords(options: FetchTraceRecordsOptions): Promise<FetchTraceRecordsResult> {
  const { region, runtimeId, traceId, includeSpans } = options;

  if (!TRACE_ID_PATTERN.test(traceId)) {
    return {
      success: false,
      error: new ValidationError('Invalid trace ID format. Expected a hex string (e.g., abc123def456).'),
    };
  }

  const [recordsResult, spansResult] = await Promise.all([
    runInsightsQuery({
      region,
      logGroupName: runtimeLogGroup(runtimeId),
      startTime: options.startTime,
      endTime: options.endTime,
      queryString: `fields @timestamp, @message, @ptr
| filter traceId = '${traceId}'
| sort @timestamp asc
| limit 10000`,
    }),
    includeSpans ? fetchSpans(region, traceId, options.startTime, options.endTime) : Promise.resolve(undefined),
  ]);

  if (!recordsResult.success) {
    return { success: false, error: recordsResult.error };
  }

  const traceData = recordsResult.rows;

  if (traceData.length === 0 && (!spansResult || !spansResult.success || spansResult.spans.length === 0)) {
    return { success: false, error: new ResourceNotFoundError(`No trace data found for trace ID: ${traceId}`) };
  }

  const records: CloudWatchTraceRecord[] = traceData.map(entry => {
    let message: unknown = entry['@message'] ?? '{}';
    try {
      message = JSON.parse(entry['@message'] ?? '{}');
    } catch {
      // Keep original string if not valid JSON
    }

    const record: CloudWatchTraceRecord = {
      '@timestamp': entry['@timestamp'] ?? '',
      '@message': message,
    };

    if (entry['@ptr']) {
      record['@ptr'] = entry['@ptr'];
    }

    return record;
  });

  const result: FetchTraceRecordsResult = spansResult?.success
    ? { success: true, records, spans: spansResult.spans }
    : { success: true, records };

  return result;
}

/**
 * Fetches a full trace from CloudWatch Logs and writes it to a JSON file.
 * Preserves all raw CloudWatch Insights fields in the output file.
 */
export async function getTrace(options: GetTraceOptions): Promise<GetTraceResult> {
  const { region, runtimeId, agentName, traceId, outputPath } = options;

  if (!TRACE_ID_PATTERN.test(traceId)) {
    return {
      success: false,
      error: new ValidationError('Invalid trace ID format. Expected a hex string (e.g., abc123def456).'),
    };
  }

  const result = await runInsightsQuery({
    region,
    logGroupName: runtimeLogGroup(runtimeId),
    startTime: options.startTime,
    endTime: options.endTime,
    queryString: `fields @timestamp, @message
| filter traceId = '${traceId}'
| sort @timestamp asc
| limit 10000`,
  });
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const traceData = result.rows;
  if (traceData.length === 0) {
    return { success: false, error: new ResourceNotFoundError(`No trace data found for trace ID: ${traceId}`) };
  }

  const parsedTrace = traceData.map(entry => {
    try {
      const parsed: unknown = JSON.parse(entry['@message'] ?? '{}');
      return { ...entry, '@message': parsed };
    } catch {
      return entry;
    }
  });

  const filePath = outputPath ?? path.join('agentcore', '.cli', 'traces', `${agentName}-${traceId}.json`);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsedTrace, null, 2));

  return { success: true, filePath: path.resolve(filePath) };
}
