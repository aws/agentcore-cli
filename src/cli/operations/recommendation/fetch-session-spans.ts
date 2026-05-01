/**
 * Fetches OTEL span records and log records from CloudWatch for a given session,
 * combining them into a SessionSpan[] suitable for inline `sessionSpans` in the
 * Recommendation API.
 *
 * Tool description recommendations require inline sessionSpans (the server-side
 * Lambda does NOT support `cloudwatchLogs` for this type). The OTEL mapper needs
 * BOTH:
 *   - Span records from the `aws/spans` log group
 *   - Log records (with body.input/output.messages) from the runtime log group
 *
 * Without log records the mapper produces "zero trajectories".
 */
import type { SessionSpan } from '../../aws/agentcore-recommendation';
import { searchLogs } from '../../aws/cloudwatch';

export interface FetchSessionSpansOptions {
  /** AWS region */
  region: string;
  /** Agent runtime ID, e.g. "myproject_MyAgent-QMd093Gl4O" */
  runtimeId: string;
  /** Session ID to filter spans for */
  sessionId: string;
  /** Lookback days (default 7) */
  lookbackDays?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
}

export interface FetchSessionSpansResult {
  spans: SessionSpan[];
  spanRecordCount: number;
  logRecordCount: number;
}

/** The log group where OTEL span records are stored (no leading slash). */
const SPANS_LOG_GROUP = 'aws/spans';

/**
 * Fetch session spans from both CloudWatch log groups and combine them.
 *
 * 1. Fetches span records from `aws/spans` filtered by session.id
 * 2. Fetches log records from the runtime log group filtered by body+input
 * 3. Filters log records client-side by matching session.id
 * 4. Returns combined array
 */
export async function fetchSessionSpans(options: FetchSessionSpansOptions): Promise<FetchSessionSpansResult> {
  const { region, runtimeId, sessionId, lookbackDays = 7, onProgress } = options;

  const runtimeLogGroup = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`;
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - lookbackDays * 24 * 60 * 60 * 1000;

  // Fetch span records and log records in parallel
  onProgress?.('Fetching span records from aws/spans...');
  const [spanRecords, logRecords] = await Promise.all([
    collectLogEvents({
      logGroupName: SPANS_LOG_GROUP,
      region,
      startTimeMs,
      endTimeMs,
      filterPattern: `"session.id" "${sessionId}"`,
    }),
    collectLogEvents({
      logGroupName: runtimeLogGroup,
      region,
      startTimeMs,
      endTimeMs,
      // Filter for log records that contain body with input messages
      filterPattern: `"body" "input"`,
    }),
  ]);

  onProgress?.(`Found ${spanRecords.length} span records, ${logRecords.length} log record candidates`);

  // Parse span records — these are already OTEL spans with attributes.session.id
  const spans: SessionSpan[] = [];
  for (const event of spanRecords) {
    try {
      const parsed = JSON.parse(event.message) as SessionSpan;
      spans.push(parsed);
    } catch {
      // Skip unparseable records
    }
  }

  // Parse and filter log records — keep only those matching our session
  let logRecordCount = 0;
  for (const event of logRecords) {
    try {
      const parsed = JSON.parse(event.message) as Record<string, unknown>;
      if (matchesSession(parsed, sessionId)) {
        spans.push(parsed as unknown as SessionSpan);
        logRecordCount++;
      }
    } catch {
      // Skip unparseable records
    }
  }

  onProgress?.(
    `Combined ${spans.length} spans (${spans.length - logRecordCount} span records + ${logRecordCount} log records)`
  );

  return {
    spans,
    spanRecordCount: spans.length - logRecordCount,
    logRecordCount,
  };
}

/**
 * Check if a parsed log record matches the target session ID.
 * Log records may have session.id in attributes or in the traceId/body context.
 */
function matchesSession(record: Record<string, unknown>, sessionId: string): boolean {
  // Check attributes.session.id (most common)
  const attrs = record.attributes as Record<string, unknown> | undefined;
  if (attrs?.['session.id'] === sessionId) return true;

  // Check nested body for session references
  const body = record.body as Record<string, unknown> | undefined;
  if (body) {
    const bodyStr = JSON.stringify(body);
    if (bodyStr.includes(sessionId)) return true;
  }

  return false;
}

/**
 * Collect all log events from a CloudWatch log group into an array.
 * Uses the existing searchLogs async generator.
 */
async function collectLogEvents(options: {
  logGroupName: string;
  region: string;
  startTimeMs: number;
  endTimeMs: number;
  filterPattern: string;
}): Promise<{ timestamp: number; message: string }[]> {
  const events: { timestamp: number; message: string }[] = [];

  try {
    for await (const event of searchLogs(options)) {
      events.push(event);
    }
  } catch (err) {
    // Log group may not exist yet (e.g. no invocations) — return empty
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ResourceNotFoundException') || msg.includes('does not exist')) {
      return [];
    }
    throw err;
  }

  return events;
}
