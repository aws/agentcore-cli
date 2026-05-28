/**
 * Collect spans from CloudWatch after agent invocations.
 *
 * Waits for an ingestion delay, then polls for spans
 * for each session. Retries on transient errors.
 */
import { getCredentialProvider } from '../../../aws';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';
import type { DocumentType } from '@smithy/types';

/**
 * Default delay before first span query (CloudWatch ingestion buffer).
 * Matches SDK's evaluation_delay_seconds default (180s).
 */
const SPAN_INGESTION_DELAY_MS = 180_000;

/** Maximum time to poll for spans after the ingestion delay. */
const SPAN_POLL_TIMEOUT_MS = 60_000;

/** Interval between poll attempts. */
const SPAN_POLL_INTERVAL_MS = 5_000;

export const SPANS_LOG_GROUP = 'aws/spans';

const SUPPORTED_SCOPES = new Set([
  'strands.telemetry.tracer',
  'opentelemetry.instrumentation.langchain',
  'openinference.instrumentation.langchain',
]);

export interface CollectSpansOptions {
  sessionIds: string[];
  region: string;
  logGroup: string;
  querySpans: (region: string, logGroup: string, sessionId: string) => Promise<DocumentType[]>;
  onProgress?: (collected: number, total: number, message?: string) => void;
}

export interface CollectedSpans {
  spans: Map<string, DocumentType[]>;
  timedOut: string[];
}

/** Returns true if the error is permanent (non-retryable). */
function isPermanentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('AccessDenied') || msg.includes('InvalidParameter');
}

/** Poll a single session for spans until we have some or the deadline passes. */
async function pollOneSession(
  sessionId: string,
  querySpans: CollectSpansOptions['querySpans'],
  region: string,
  logGroup: string,
  timeoutMs: number
): Promise<DocumentType[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const spans = await querySpans(region, logGroup, sessionId);
      if (spans.length > 0) return spans;
    } catch (err) {
      if (isPermanentError(err)) {
        throw new Error(`CloudWatch query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Transient errors (throttling, 503) — retry next interval
    }
    await sleep(SPAN_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Collect spans for all sessions after ingestion delay.
 * Each session polls independently with its own timeout budget.
 */
export async function collectSpans(options: CollectSpansOptions): Promise<CollectedSpans> {
  const { sessionIds, querySpans, onProgress } = options;

  // Phase 1: Wait for CloudWatch ingestion
  onProgress?.(0, sessionIds.length, `Waiting for span ingestion (${SPAN_INGESTION_DELAY_MS / 1000}s)...`);
  await sleep(SPAN_INGESTION_DELAY_MS);

  // Phase 2: Poll each session in parallel — use allSettled so one failure doesn't abort the rest
  let collectedCount = 0;
  const settled = await Promise.allSettled(
    sessionIds.map(async sessionId => {
      const spans = await pollOneSession(sessionId, querySpans, options.region, options.logGroup, SPAN_POLL_TIMEOUT_MS);
      if (spans) {
        collectedCount++;
        onProgress?.(collectedCount, sessionIds.length);
      }
      return { sessionId, spans };
    })
  );

  const collected = new Map<string, DocumentType[]>();
  const timedOut: string[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      if (r.spans) collected.set(r.sessionId, r.spans);
      else timedOut.push(r.sessionId);
    } else {
      // Rejected sessions are treated as timed out
      timedOut.push('unknown');
    }
  }

  return { spans: collected, timedOut };
}

/**
 * Extract unique traceIds from spans in appearance order.
 * Used by ground-truth mapping (turn[i] → traceIds[i]).
 */
export function extractTraceIds(spans: DocumentType[]): string[] {
  const seen = new Set<string>();
  const traceIds: string[] = [];
  for (const span of spans) {
    const traceId = (span as Record<string, unknown>).traceId as string | undefined;
    if (traceId && !seen.has(traceId)) {
      seen.add(traceId);
      traceIds.push(traceId);
    }
  }
  return traceIds;
}

/**
 * Extract span IDs that represent tool calls from session spans.
 */
export function extractToolCallSpanIds(spans: DocumentType[]): string[] {
  const spanIds: string[] = [];
  for (const span of spans) {
    const doc = span as Record<string, unknown>;
    const spanId = doc.spanId as string | undefined;
    if (!spanId) continue;

    // Tool call spans must have a tool name attribute — kind=CLIENT alone is too broad
    const attrs = doc.attributes as Record<string, unknown> | undefined;
    if (attrs?.['gen_ai.tool.name'] ?? attrs?.['tool.name']) {
      spanIds.push(spanId);
    }
  }
  return spanIds;
}

/** Sanitize a value for use in CloudWatch Insights query strings by removing single quotes. */
export function sanitizeQueryValue(value: string): string {
  return value.replace(/'/g, '');
}

/**
 * Execute a CloudWatch Logs Insights query, returning [] if the log group does not exist.
 */
export async function executeQueryGraceful(
  client: CloudWatchLogsClient,
  logGroupName: string,
  queryString: string,
  startTimeSec: number,
  endTimeSec: number
): Promise<ResultField[][]> {
  try {
    return await executeQuery(client, logGroupName, queryString, startTimeSec, endTimeSec);
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const msg = err instanceof Error ? err.message : String(err);
    if (errName === 'ResourceNotFoundException' || msg.includes('does not exist')) {
      return [];
    }
    throw err;
  }
}

/**
 * Execute a CloudWatch Logs Insights query and wait for results.
 */
export async function executeQuery(
  client: CloudWatchLogsClient,
  logGroupName: string,
  queryString: string,
  startTimeSec: number,
  endTimeSec: number
): Promise<ResultField[][]> {
  const startQuery = await client.send(
    new StartQueryCommand({
      logGroupName,
      startTime: startTimeSec,
      endTime: endTimeSec,
      queryString,
    })
  );

  if (!startQuery.queryId) {
    throw new Error('Failed to start CloudWatch Logs Insights query');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const queryResults = await client.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));
    const status = queryResults.status ?? 'Unknown';

    if (status === 'Failed' || status === 'Cancelled') {
      throw new Error(`CloudWatch query ${status.toLowerCase()}`);
    }

    if (status === 'Complete') {
      return queryResults.results ?? [];
    }
  }

  throw new Error('CloudWatch query timed out after 60 seconds');
}

/**
 * Extract parsed @message documents from CloudWatch Insights results.
 */
function extractMessages(rows: ResultField[][]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  for (const row of rows) {
    const messageField = row.find(f => f.field === '@message');
    if (messageField?.value) {
      try {
        docs.push(JSON.parse(messageField.value) as Record<string, unknown>);
      } catch {
        // Skip non-JSON log lines
      }
    }
  }
  return docs;
}

/**
 * Check if a document is relevant for evaluation:
 * - Has a supported instrumentation scope, OR
 * - Is a log record with conversation data (body.input / body.output)
 */
function isRelevantForEval(doc: Record<string, unknown>): boolean {
  const scope = doc.scope as Record<string, unknown> | undefined;
  const scopeName = scope?.name as string | undefined;
  if (scopeName && SUPPORTED_SCOPES.has(scopeName)) {
    return true;
  }

  const body = doc.body;
  if (body && typeof body === 'object' && ('input' in body || 'output' in body)) {
    return true;
  }

  return false;
}

export interface SessionSpans {
  sessionId: string;
  spans: DocumentType[];
}

export interface FetchSpansOptions {
  runtimeId: string;
  runtimeLogGroup: string;
  region: string;
  lookbackDays: number;
  sessionId?: string;
  traceId?: string;
}

/**
 * Fetch OTel spans from the `aws/spans` log group and runtime logs from the agent's
 * log group, then group them by session.
 *
 * The Evaluate API requires spans from a single session per call.
 */
export async function fetchSessionSpans(opts: FetchSpansOptions): Promise<SessionSpans[]> {
  const { runtimeId, runtimeLogGroup, region, lookbackDays } = opts;
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - lookbackDays * 24 * 60 * 60 * 1000;
  const startTimeSec = Math.floor(startTimeMs / 1000);
  const endTimeSec = Math.floor(endTimeMs / 1000);

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region,
  });

  // 1. Query proper OTel spans from both log groups
  let spanQuery = `fields @message, attributes.session.id as sessionId, traceId
     | parse resource.attributes.cloud.resource_id "runtime/*/" as parsedAgentId
     | filter parsedAgentId = '${sanitizeQueryValue(runtimeId)}'
     | filter ispresent(scope.name) and ispresent(kind)`;

  if (opts.sessionId) {
    spanQuery += `\n     | filter attributes.session.id = '${sanitizeQueryValue(opts.sessionId)}'`;
  }
  if (opts.traceId) {
    spanQuery += `\n     | filter traceId = '${sanitizeQueryValue(opts.traceId)}'`;
  }

  spanQuery += `\n     | sort startTimeUnixNano asc\n     | limit 10000`;

  const [sharedSpanRows, runtimeSpanRows] = await Promise.all([
    executeQueryGraceful(client, SPANS_LOG_GROUP, spanQuery, startTimeSec, endTimeSec),
    executeQueryGraceful(client, runtimeLogGroup, spanQuery, startTimeSec, endTimeSec),
  ]);
  const allSpanRows = [...sharedSpanRows, ...runtimeSpanRows];

  // Group spans by session and collect trace IDs
  const sessionMap = new Map<string, DocumentType[]>();
  const traceIds = new Set<string>();

  for (const row of allSpanRows) {
    const messageField = row.find(f => f.field === '@message');
    const sessionField = row.find(f => f.field === 'sessionId');
    const traceField = row.find(f => f.field === 'traceId');

    if (!messageField?.value) continue;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(messageField.value) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = sessionField?.value ?? 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, []);
    }
    sessionMap.get(sessionId)!.push(doc as DocumentType);

    if (traceField?.value) {
      traceIds.add(traceField.value);
    }
  }

  if (sessionMap.size === 0) {
    return [];
  }

  // 2. Query runtime logs from the agent's log group for the trace IDs found
  if (traceIds.size > 0) {
    const traceFilter = [...traceIds].map(t => `'${sanitizeQueryValue(t)}'`).join(', ');
    let logRows: ResultField[][] = [];
    try {
      logRows = await executeQuery(
        client,
        runtimeLogGroup,
        `fields @message, traceId
         | filter traceId in [${traceFilter}]
         | sort @timestamp asc
         | limit 10000`,
        startTimeSec,
        endTimeSec
      );
    } catch {
      // Runtime log group may not exist yet; continue with spans only
    }

    const logDocs = extractMessages(logRows);

    // Match runtime logs to sessions via traceId
    // Build traceId → sessionId mapping from spans
    const traceToSession = new Map<string, string>();
    for (const row of allSpanRows) {
      const traceField = row.find(f => f.field === 'traceId');
      const sessionField = row.find(f => f.field === 'sessionId');
      if (traceField?.value && sessionField?.value) {
        traceToSession.set(traceField.value, sessionField.value);
      }
    }

    for (const logDoc of logDocs) {
      if (!isRelevantForEval(logDoc)) continue;

      const logTraceId = logDoc.traceId as string | undefined;
      const sessionId = logTraceId ? (traceToSession.get(logTraceId) ?? 'unknown') : 'unknown';
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(logDoc as DocumentType);
    }
  }

  // 3. Build session list — aws/spans docs are already scoped by runtimeId (step 1),
  //    and runtime log docs were filtered through isRelevantForEval (step 2).
  //    We keep all docs so the Evaluate API has full trace context for resolving
  //    template variables like {context} and {assistant_turn}.
  const sessions: SessionSpans[] = [];
  for (const [sessionId, docs] of sessionMap) {
    if (docs.length > 0) {
      sessions.push({ sessionId, spans: docs });
    }
  }

  return sessions;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
