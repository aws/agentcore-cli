import { getCredentialProvider } from '../../aws';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';

const DEFAULT_LOOKBACK_MS = 12 * 60 * 60 * 1000;

export interface InsightsQueryOptions {
  region: string;
  logGroupName: string;
  queryString: string;
  startTime?: number;
  endTime?: number;
}

export interface InsightsQueryResult {
  success: boolean;
  rows?: Record<string, string>[];
  error?: string;
}

async function pollQueryResults(client: CloudWatchLogsClient, queryId: string): Promise<InsightsQueryResult> {
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const queryResults = await client.send(new GetQueryResultsCommand({ queryId }));
    const status = queryResults.status ?? 'Unknown';

    if (status === 'Complete' || status === 'Failed' || status === 'Cancelled') {
      if (status !== 'Complete') {
        return { success: false, error: `Query ${status.toLowerCase()}` };
      }

      const rows = (queryResults.results ?? []).map(row => {
        const fields: Record<string, string> = {};
        for (const field of row) {
          if (field.field && field.value) {
            fields[field.field] = field.value;
          }
        }
        return fields;
      });
      return { success: true, rows };
    }
  }

  return { success: false, error: 'Query timed out after 60 seconds' };
}

export async function runInsightsQuery(options: InsightsQueryOptions): Promise<InsightsQueryResult> {
  const { region, logGroupName, queryString } = options;

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region,
  });

  const now = Date.now();
  const endTime = options.endTime ?? now;
  const startTime = options.startTime ?? endTime - DEFAULT_LOOKBACK_MS;

  try {
    const startQuery = await client.send(
      new StartQueryCommand({
        logGroupName,
        startTime: Math.floor(startTime / 1000),
        endTime: Math.floor(endTime / 1000),
        queryString,
      })
    );

    if (!startQuery.queryId) {
      return { success: false, error: 'Failed to start CloudWatch Logs Insights query' };
    }

    return await pollQueryResults(client, startQuery.queryId);
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
