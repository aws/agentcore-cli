import { getCredentialProvider } from '../../aws';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import fs from 'node:fs';
import path from 'node:path';

export interface GetTraceOptions {
  region: string;
  runtimeId: string;
  agentName: string;
  traceId: string;
  outputPath?: string;
  startTime?: number;
  endTime?: number;
}

export interface GetTraceResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/**
 * Fetches a full trace from CloudWatch Logs and writes it to a JSON file.
 *
 * Log group naming convention: /aws/bedrock-agentcore/runtimes/{runtimeId}-DEFAULT
 * Trace ID is stored in the @message JSON body as "traceId".
 */
export async function getTrace(options: GetTraceOptions): Promise<GetTraceResult> {
  const { region, runtimeId, agentName, traceId, outputPath } = options;

  if (!/^[a-fA-F0-9-]+$/.test(traceId)) {
    return { success: false, error: 'Invalid trace ID format. Expected a hex string (e.g., abc123def456).' };
  }

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
        queryString: `fields @timestamp, @message
| filter traceId = '${traceId}'
| sort @timestamp asc
| limit 1000`,
      })
    );

    if (!startQuery.queryId) {
      return { success: false, error: 'Failed to start CloudWatch Logs Insights query' };
    }

    // Poll for results
    let traceData: Record<string, string>[] = [];
    let queryStatus = 'Running';

    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const queryResults = await client.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));

      queryStatus = queryResults.status ?? 'Unknown';

      if (queryStatus === 'Complete' || queryStatus === 'Failed' || queryStatus === 'Cancelled') {
        if (queryStatus !== 'Complete') {
          return { success: false, error: `Query ${queryStatus.toLowerCase()}` };
        }

        traceData = (queryResults.results ?? []).map(row => {
          const fields: Record<string, string> = {};
          for (const field of row) {
            if (field.field && field.value) {
              fields[field.field] = field.value;
            }
          }
          return fields;
        });
        break;
      }
    }

    if (queryStatus === 'Running') {
      return { success: false, error: 'Query timed out after 60 seconds' };
    }

    if (traceData.length === 0) {
      return { success: false, error: `No trace data found for trace ID: ${traceId}` };
    }

    // Parse @message fields as JSON where possible
    const parsedTrace = traceData.map(entry => {
      try {
        const parsed: unknown = JSON.parse(entry['@message'] ?? '{}');
        return { ...entry, '@message': parsed };
      } catch {
        return entry;
      }
    });

    // Write to file
    const filePath = outputPath ?? path.join('agentcore', '.cli', 'traces', `${agentName}-${traceId}.json`);

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(parsedTrace, null, 2));

    return { success: true, filePath: path.resolve(filePath) };
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
