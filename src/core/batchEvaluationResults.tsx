import { GetLogEventsCommand, type CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { BatchEvaluationResultEntry } from "../handlers/eval/types";
import type { Logger } from "../logging";

// Per-session batch-evaluation result retrieval, mirroring
// core/onlineEvalExecutionRole.tsx's pattern: a self-contained module that takes
// an injected AWS client (here CloudWatchLogsClient) and owns one slice of Core's
// behavior. A completed batch evaluation writes each score as an OTel-shaped log
// record to a per-job CloudWatch stream; this module reads that stream and parses
// the records. EvalClient calls readEvaluationResults with the client from
// `this.clients.logs(...)` and the log group + stream from the job's outputConfig.

// Terminal batch-evaluation statuses — after these, results are final and worth
// retrieving. Mirrors the AgentCore BatchEvaluationStatus enum's terminal arm.
const TERMINAL_STATUSES = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "STOPPED"]);

export function isTerminalStatus(status?: string): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

// GetLogEvents returns at most 1 MB / 10,000 events per call, so a job with many
// results spans multiple pages. This caps the page loop as a safety valve against
// a non-advancing token (see below); at 10k events/page it allows ~1M results,
// far beyond the 500-session job limit.
const MAX_RESULT_PAGES = 100;

// readEvaluationResults reads and parses the per-session/-trace/-tool scores from
// a completed batch evaluation's CloudWatch result stream, following pagination to
// completion. The caller supplies the log group and stream name from the job's
// GetBatchEvaluation outputConfig (the service-selected values — we do not derive
// the stream name, since its format is not part of the SDK contract).
export async function readEvaluationResults(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  logStreamName: string,
  logger: Logger,
): Promise<BatchEvaluationResultEntry[]> {
  const results: BatchEvaluationResultEntry[] = [];

  // Page forward from the head. GetLogEvents echoes the input token back as
  // nextForwardToken once the stream is exhausted, so the loop ends when the
  // token stops advancing. startFromHead is only honored on the first call (no
  // token); subsequent calls are positioned by the token.
  let token: string | undefined;
  for (let page = 0; page < MAX_RESULT_PAGES; page++) {
    const response = await logs.send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        startFromHead: true,
        nextToken: token,
      }),
    );

    for (const event of response.events ?? []) {
      if (!event.message) continue;
      const entry = parseEvaluationLogEvent(event.message, logger);
      if (entry) results.push(entry);
    }

    const next = response.nextForwardToken;
    if (!next || next === token) return results; // exhausted: token stopped advancing
    token = next;
  }

  logger.warn(
    `stopped reading batch-evaluation results after ${MAX_RESULT_PAGES} pages; results may be truncated`,
  );
  return results;
}

// parseEvaluationLogEvent turns one CloudWatch result-log message into a result
// entry, or null for non-JSON / non-evaluation lines (log control lines, blank
// messages). AgentCore emits each score as an OTel-shaped log record named
// `gen_ai.evaluation.result`: the `gen_ai.evaluation.*` scores and the
// `session.id` live under `attributes`, the trace id is the top-level `traceId`,
// and the level is `attributes["aws.bedrock_agentcore.evaluation_level"]` (e.g.
// "Trace" / "Session"). Field names verified against a recorded result stream
// (src/core/__fixtures__/batch-eval-result-log-events.json). We keep `level` and
// the ids — the old CLI dropped them, flattening every level into one list.
export function parseEvaluationLogEvent(
  message: string,
  logger: Logger,
): BatchEvaluationResultEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message) as Record<string, unknown>;
  } catch {
    // Swallow rather than throw: CloudWatch result streams interleave non-JSON
    // control lines with the evaluation records, so one unparseable line is
    // expected noise — failing here would drop every result for the job over it.
    // Warn (not silent) so a systematic format change is still visible in logs.
    logger.warn("skipping unparseable batch-evaluation result log line");
    return null;
  }
  const attrs = (parsed["attributes"] ?? {}) as Record<string, unknown>;
  const evaluatorId = attrs["gen_ai.evaluation.name"] as string | undefined;
  if (!evaluatorId) return null;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  // Keys are read verbatim as the recorded stream emits them: scores, level,
  // session id, and tool name under `attributes`; traceId/spanId at the top
  // level. If AgentCore renames one, the corresponding field goes undefined and
  // the fixture-replay test fails — the signal to update the key here.
  return {
    evaluatorId,
    level: str(attrs["aws.bedrock_agentcore.evaluation_level"]),
    sessionId: str(attrs["session.id"]),
    traceId: str(parsed["traceId"]),
    spanId: str(parsed["spanId"]),
    toolName: str(attrs["gen_ai.tool.name"]),
    score: attrs["gen_ai.evaluation.score.value"] as number | undefined,
    label: str(attrs["gen_ai.evaluation.score.label"]),
    explanation: str(attrs["gen_ai.evaluation.explanation"]),
    error: str(attrs["gen_ai.evaluation.error"]),
  };
}
