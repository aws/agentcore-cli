import { getCredentialProvider } from '../../aws';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';

export interface TraceEntry {
  traceId: string;
  timestamp: string;
  sessionId?: string;
  spanCount?: string;
}

export interface ListTracesOptions {
  region: string;
  runtimeId: string;
  agentName: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

export interface ListTracesResult {
  success: boolean;
  traces?: TraceEntry[];
  error?: string;
}

/**
 * Lists recent traces for a deployed agent by querying CloudWatch Logs Insights.
 *
 * Log group naming convention: /aws/bedrock-agentcore/runtimes/{runtimeId}-DEFAULT
 * Trace data is in the @message JSON body with fields like traceId, spanId, etc.
 */
export async function listTraces(options: ListTracesOptions): Promise<ListTracesResult> {
  const { region, runtimeId, limit = 20 } = options;

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region,
  });

  const logGroupName = `/aws/bedrock-agentcore/runtimes/${runtimeId}-${DEFAULT_ENDPOINT_NAME}`;

  const now = Date.now();
  const endTime = options.endTime ?? now;
  const startTime = options.startTime ?? endTime - 12 * 60 * 60 * 1000; // default: last 12 hours

  try {
    const startQuery = await client.send(
      new StartQueryCommand({
        logGroupName,
        startTime: Math.floor(startTime / 1000),
        endTime: Math.floor(endTime / 1000),
        queryString: `stats earliest(@timestamp) as firstSeen, latest(@timestamp) as lastSeen, count(*) as spanCount, earliest(attributes.session.id) as sessionId by traceId
| sort lastSeen desc
| limit ${limit}`,
      })
    );

    if (!startQuery.queryId) {
      return { success: false, error: 'Failed to start CloudWatch Logs Insights query' };
    }

    // Poll for results
    let status = 'Running';
    let results: TraceEntry[] = [];

    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const queryResults = await client.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));

      status = queryResults.status ?? 'Unknown';

      if (status === 'Complete' || status === 'Failed' || status === 'Cancelled') {
        if (status !== 'Complete') {
          return { success: false, error: `Query ${status.toLowerCase()}` };
        }

        results = (queryResults.results ?? []).map(row => {
          const fields: Record<string, string> = {};
          for (const field of row) {
            if (field.field && field.value) {
              fields[field.field] = field.value;
            }
          }
          return {
            traceId: fields.traceId ?? 'unknown',
            timestamp: fields.lastSeen ?? fields.firstSeen ?? 'unknown',
            sessionId: fields.sessionId,
            spanCount: fields.spanCount,
          };
        });
        break;
      }
    }

    if (status === 'Running') {
      return { success: false, error: 'Query timed out after 60 seconds' };
    }

    return { success: true, traces: results };
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === 'ResourceNotFoundException') {
      return {
        success: false,
        error: `Log group '${logGroupName}' not found. The agent may not have been invoked yet, or traces may not be enabled.`,
      };
    }
    return { success: false, error: err.message ?? String(error) };
  }
}
