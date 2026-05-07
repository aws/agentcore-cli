import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import { runInsightsQuery } from './insights-query';
import type { ListTracesOptions, ListTracesResult, TraceEntry } from './types';

/**
 * Lists recent traces for a deployed agent by querying CloudWatch Logs Insights.
 *
 * Log group naming convention: /aws/bedrock-agentcore/runtimes/{runtimeId}-DEFAULT
 * Trace data is in the @message JSON body with fields like traceId, spanId, etc.
 */
export async function listTraces(options: ListTracesOptions): Promise<ListTracesResult> {
  const { region, runtimeId, limit = 20 } = options;

  const logGroupName = `/aws/bedrock-agentcore/runtimes/${runtimeId}-${DEFAULT_ENDPOINT_NAME}`;

  const result = await runInsightsQuery({
    region,
    logGroupName,
    startTime: options.startTime,
    endTime: options.endTime,
    queryString: `stats earliest(@timestamp) as firstSeen, latest(@timestamp) as lastSeen, count(*) as spanCount, earliest(attributes.session.id) as sessionId by traceId
| sort lastSeen desc
| limit ${limit}`,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const traces = (result.rows ?? []).reduce<TraceEntry[]>((acc, row) => {
    if (row.traceId) {
      acc.push({
        traceId: row.traceId,
        timestamp: row.lastSeen ?? row.firstSeen ?? 'unknown',
        sessionId: row.sessionId,
        spanCount: row.spanCount,
      });
    }
    return acc;
  }, []);

  return { success: true, traces };
}
