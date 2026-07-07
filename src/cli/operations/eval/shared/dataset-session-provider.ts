/**
 * Dataset scenario orchestration for dataset-driven evaluation.
 *
 * Two functions by responsibility:
 * - runDatasetScenarios — load + invoke (Phase A + B). Used by batch eval.
 * - runDatasetScenariosAndCollectSpans — composes the runner + span collection + ground truth.
 *   Used by on-demand eval.
 */
import { ConfigIO } from '../../../../lib';
import type { EvaluationReferenceInput } from '../../../aws/agentcore';
import { runtimeLogGroup } from '../../../aws/cloudwatch';
import type { AgentContext } from '../../invoke/resolve-agent-context';
import { loadDatasetScenarios } from './dataset-loader';
import { executeScenarios } from './scenario-executor';
import type { ScenarioInvocationResult } from './scenario-executor';
import { collectSpans, extractTraceIds } from './span-collector';
import type { PredefinedScenario } from './types';
import type { DocumentType } from '@smithy/types';

interface BuildReferenceInputsArgs {
  scenario: PredefinedScenario;
  sessionId: string;
  traceIds: string[];
}

/**
 * Build evaluationReferenceInputs for a single scenario.
 *
 * - Session-level: assertions + expected_trajectory (applied to full session)
 * - Per-trace: turn[i].expectedResponse → traceIds[i] (by appearance order)
 *   If traceIds.length < turns.length, extra turns are skipped (SDK behavior).
 */
export function buildReferenceInputs(options: BuildReferenceInputsArgs): EvaluationReferenceInput[] {
  const { scenario, sessionId, traceIds } = options;
  const inputs: EvaluationReferenceInput[] = [];

  const hasAssertions = scenario.assertions && scenario.assertions.length > 0;
  const hasTrajectory = scenario.expected_trajectory && scenario.expected_trajectory.length > 0;

  if (hasAssertions || hasTrajectory) {
    inputs.push({
      context: { spanContext: { sessionId } },
      ...(hasAssertions && { assertions: scenario.assertions!.map(text => ({ text })) }),
      ...(hasTrajectory && { expectedTrajectory: { toolNames: scenario.expected_trajectory! } }),
    });
  }

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]!;
    if (!turn.expectedResponse) continue;
    if (i >= traceIds.length) break;

    inputs.push({
      context: { spanContext: { sessionId, traceId: traceIds[i] } },
      expectedResponse: { text: turn.expectedResponse },
    });
  }

  return inputs;
}

export interface RunDatasetScenariosOptions {
  agentContext: AgentContext;
  datasetName: string;
  version?: string;
  /** Base directory for resolving dataset file paths. If omitted, resolved via ConfigIO. */
  configBaseDir?: string;
  onProgress?: (phase: string, message: string) => void;
}

export interface RunDatasetScenariosResult {
  scenarioResults: ScenarioInvocationResult[];
  scenarios: PredefinedScenario[];
}

export interface RunDatasetScenariosAndCollectSpansOptions extends RunDatasetScenariosOptions {
  querySpans: (region: string, logGroup: string, sessionId: string) => Promise<DocumentType[]>;
}

export interface RunDatasetScenariosAndCollectSpansResult extends RunDatasetScenariosResult {
  sessions: { sessionId: string; spans: DocumentType[] }[];
  referenceInputs: EvaluationReferenceInput[];
}

/**
 * Phase A + B: Load scenarios from dataset, invoke agent with each scenario.
 *
 * Throws if all scenarios fail invocation.
 */
export async function runDatasetScenarios(options: RunDatasetScenariosOptions): Promise<RunDatasetScenariosResult> {
  const { agentContext, datasetName, version, onProgress } = options;

  // Phase A: Load dataset scenarios
  onProgress?.('load', `Loading dataset "${datasetName}"...`);
  const configBaseDir = options.configBaseDir ?? new ConfigIO().getConfigRoot();
  const scenarios = await loadDatasetScenarios({ datasetName, version, configBaseDir });
  onProgress?.('load', `Loaded ${scenarios.length} scenarios`);

  // Phase B: Execute scenarios (5 concurrent)
  onProgress?.('invoke', `Invoking agent with ${scenarios.length} scenarios...`);
  const scenarioResults = await executeScenarios({
    scenarios,
    agentContext,
    onProgress: (completed, total, current) => {
      const status = current.status === 'success' ? '✓' : '✗';
      onProgress?.('invoke', `[${completed}/${total}] ${current.scenarioId}: ${status}`);
    },
  });

  const successfulResults = scenarioResults.filter(r => r.status === 'success');
  const failedCount = scenarioResults.length - successfulResults.length;
  onProgress?.(
    'invoke',
    `✓ ${successfulResults.length}/${scenarioResults.length} scenarios invoked${failedCount > 0 ? ` (${failedCount} failed)` : ''}`
  );

  if (successfulResults.length === 0) {
    throw new Error('All scenarios failed during invocation. No sessions to evaluate.');
  }

  return { scenarioResults, scenarios };
}

/**
 * Phase A + B + C: Run scenarios, then wait for span ingestion, collect spans,
 * and build evaluation reference inputs from dataset ground truth.
 *
 * Composes runDatasetScenarios and adds the span collection step.
 */
export async function runDatasetScenariosAndCollectSpans(
  options: RunDatasetScenariosAndCollectSpansOptions
): Promise<RunDatasetScenariosAndCollectSpansResult> {
  const { agentContext, querySpans, onProgress } = options;

  const { scenarioResults, scenarios } = await runDatasetScenarios(options);
  const successfulResults = scenarioResults.filter(r => r.status === 'success');

  const logGroup = runtimeLogGroup(agentContext.runtimeId, agentContext.endpoint);
  const sessionIds = successfulResults.map(r => r.sessionId);

  onProgress?.('collect', 'Waiting for span ingestion (15s)...');
  const { spans: collectedSpans, timedOut } = await collectSpans({
    sessionIds,
    region: agentContext.region,
    logGroup,
    querySpans,
    onProgress: (collected, total) => {
      onProgress?.('collect', `Collecting spans... (${collected}/${total} sessions)`);
    },
  });

  if (timedOut.length > 0) {
    onProgress?.('collect', `⚠ ${timedOut.length} sessions timed out waiting for spans`);
  }
  onProgress?.('collect', `✓ ${collectedSpans.size}/${sessionIds.length} sessions collected`);

  const sessions: { sessionId: string; spans: DocumentType[] }[] = [];
  const refInputSources: { scenario: PredefinedScenario; sessionId: string; traceIds: string[] }[] = [];

  for (const result of successfulResults) {
    const spans = collectedSpans.get(result.sessionId);
    if (!spans || spans.length === 0) continue;

    sessions.push({ sessionId: result.sessionId, spans });

    const traceIds = extractTraceIds(spans);
    const scenario = scenarios.find(s => s.scenario_id === result.scenarioId);
    if (!scenario) continue; // Defensive: scenarioId always matches a loaded scenario
    refInputSources.push({ scenario, sessionId: result.sessionId, traceIds });
  }

  const referenceInputs = refInputSources.flatMap(({ scenario, sessionId, traceIds }) =>
    buildReferenceInputs({ scenario, sessionId, traceIds })
  );

  return { sessions, referenceInputs, scenarioResults, scenarios };
}
