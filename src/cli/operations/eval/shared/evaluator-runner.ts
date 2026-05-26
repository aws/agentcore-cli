/**
 * Shared evaluator-loop runner for dataset and historical-trace eval modes.
 *
 * Handles TRACE/TOOL_CALL/SESSION level routing, batching targetTraceIds/targetSpanIds
 * into chunks of 10 (Evaluate API limit), per-session ref input filtering, and score
 * aggregation.
 */
import type { EvaluationReferenceInput } from '../../../aws/agentcore';
import { evaluate } from '../../../aws/agentcore';
import type { EvalEvaluatorResult, EvalSessionScore } from '../types';
import { extractToolCallSpanIds, extractTraceIds } from './span-collector';
import type { DocumentType } from '@smithy/types';

type EvaluatorLevel = 'SESSION' | 'TRACE' | 'TOOL_CALL';

export interface SessionWithSpans {
  sessionId: string;
  spans: DocumentType[];
  /** Optional scenario tag for dataset mode — flows into EvalSessionScore. */
  scenarioId?: string;
}

export interface RunEvaluatorsOptions {
  region: string;
  evaluatorIds: string[];
  evaluatorLabels: string[];
  evaluatorLevels: Map<string, EvaluatorLevel>;
  sessions: SessionWithSpans[];
  /** Per-session ref inputs. Dataset mode: one entry per session. Historical: one entry for targeted session. */
  refInputsBySession?: Map<string, EvaluationReferenceInput[]>;
}

const BATCH_SIZE = 10;

function batchTargetIds(traceIds?: string[], spanIds?: string[]): { traceIds?: string[]; spanIds?: string[] }[] {
  const result: { traceIds?: string[]; spanIds?: string[] }[] = [];
  if (traceIds) {
    for (let i = 0; i < traceIds.length; i += BATCH_SIZE) {
      result.push({ traceIds: traceIds.slice(i, i + BATCH_SIZE) });
    }
  } else if (spanIds) {
    for (let i = 0; i < spanIds.length; i += BATCH_SIZE) {
      result.push({ spanIds: spanIds.slice(i, i + BATCH_SIZE) });
    }
  } else {
    result.push({ traceIds: undefined, spanIds: undefined });
  }
  return result;
}

function resolveTargets(
  level: EvaluatorLevel,
  spans: DocumentType[]
): { traceIds?: string[]; spanIds?: string[] } | null {
  if (level === 'TRACE') {
    const traceIds = extractTraceIds(spans);
    return traceIds.length > 0 ? { traceIds, spanIds: undefined } : null;
  }
  if (level === 'TOOL_CALL') {
    const spanIds = extractToolCallSpanIds(spans);
    return spanIds.length > 0 ? { traceIds: undefined, spanIds } : null;
  }
  return { traceIds: undefined, spanIds: undefined };
}

/**
 * Run all evaluators against all sessions. Shared by dataset and historical-trace modes.
 */
export async function runEvaluatorsOverSessions(opts: RunEvaluatorsOptions): Promise<EvalEvaluatorResult[]> {
  const results: EvalEvaluatorResult[] = [];

  for (let i = 0; i < opts.evaluatorIds.length; i++) {
    const evaluatorId = opts.evaluatorIds[i]!;
    const evaluatorName = opts.evaluatorLabels[i] ?? evaluatorId;
    const level = opts.evaluatorLevels.get(evaluatorId) ?? 'SESSION';

    const sessionScores: EvalSessionScore[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;

    for (const session of opts.sessions) {
      const targets = resolveTargets(level, session.spans);
      if (!targets) continue;

      for (const batch of batchTargetIds(targets.traceIds, targets.spanIds)) {
        const response = await evaluate({
          region: opts.region,
          evaluatorId,
          sessionSpans: session.spans,
          targetTraceIds: batch.traceIds,
          targetSpanIds: batch.spanIds,
          evaluationReferenceInputs: opts.refInputsBySession?.get(session.sessionId),
        });

        for (const r of response.evaluationResults) {
          sessionScores.push({
            sessionId: r.context?.sessionId ?? session.sessionId,
            scenarioId: session.scenarioId,
            traceId: r.context?.traceId,
            spanId: r.context?.spanId,
            value: r.value ?? 0,
            label: r.label,
            explanation: r.explanation,
            errorMessage: r.errorMessage,
          });
          totalInputTokens += r.tokenUsage?.inputTokens ?? 0;
          totalOutputTokens += r.tokenUsage?.outputTokens ?? 0;
          totalTokens += r.tokenUsage?.totalTokens ?? 0;
        }
      }
    }

    const valid = sessionScores.filter(s => !s.errorMessage);
    const aggregateScore = valid.length > 0 ? valid.reduce((sum, s) => sum + s.value, 0) / valid.length : 0;

    results.push({
      evaluator: evaluatorName,
      aggregateScore,
      sessionScores,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens },
    });
  }

  return results;
}
