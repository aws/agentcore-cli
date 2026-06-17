/**
 * Dataset Phase-1 for batch evaluation (caller-side, blocking).
 *
 * The engine's create() is a single API call, but dataset-mode batch evaluation first needs to
 * invoke the agent against every dataset scenario and wait for CloudWatch ingestion. That work is
 * the CALLER's responsibility (CLI/TUI) — this helper performs it and returns the sessionIds +
 * ground-truth sessionMetadata to hand to engine.start('batch-evaluation', ...).
 */
import { ConfigIO } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import type { SessionMetadataEntry } from '../../../aws/agentcore-batch-evaluation';
import { runDatasetScenarios } from '../../eval/shared/dataset-session-provider';
import { resolveAgentContext } from '../../invoke/resolve-agent-context';

/** Delay before submitting batch eval to allow CloudWatch span ingestion. Matches the SDK default. */
export const BATCH_INGESTION_DELAY_MS = 180_000;

export interface DatasetPhase1Options {
  agent: string;
  datasetName: string;
  datasetVersion?: string;
  endpoint?: string;
  configIO?: ConfigIO;
  onProgress?: (phase: string, message: string) => void;
  /** Override the ingestion wait (tests). */
  ingestionDelayMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export type DatasetPhase1Result = Result<{
  sessionIds: string[];
  sessionMetadata: SessionMetadataEntry[];
}>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run dataset scenarios, wait for ingestion, and build sessionIds + ground-truth metadata. */
export async function runDatasetPhase1(options: DatasetPhase1Options): Promise<DatasetPhase1Result> {
  const configIO = options.configIO ?? new ConfigIO();
  const sleep = options.sleep ?? defaultSleep;

  try {
    const [projectSpec, deployedState, awsTargets] = await Promise.all([
      configIO.readProjectSpec(),
      configIO.readDeployedState(),
      configIO.resolveAWSDeploymentTargets(),
    ]);

    const agentContext = await resolveAgentContext({
      project: projectSpec,
      deployedState,
      awsTargets,
      agentName: options.agent,
      endpoint: options.endpoint,
    });

    options.onProgress?.('invoking', `Invoking agent with dataset "${options.datasetName}"...`);
    const datasetResult = await runDatasetScenarios({
      agentContext,
      datasetName: options.datasetName,
      version: options.datasetVersion,
      configBaseDir: configIO.getConfigRoot(),
      onProgress: (phase, msg) => options.onProgress?.(phase, msg),
    });

    const successful = datasetResult.scenarioResults.filter(r => r.status === 'success');
    if (successful.length === 0) {
      return { success: false, error: new Error('All scenarios failed during invocation. No sessions to evaluate.') };
    }

    const sessionIds = successful.map(r => r.sessionId);
    const sessionMetadata = successful.map(r => {
      const scenario = datasetResult.scenarios.find(s => s.scenario_id === r.scenarioId);
      return {
        sessionId: r.sessionId,
        testScenarioId: r.scenarioId,
        groundTruth: scenario
          ? {
              inline: {
                ...(scenario.assertions ? { assertions: scenario.assertions.map(a => ({ text: a })) } : {}),
                ...(scenario.expected_trajectory
                  ? { expectedTrajectory: { toolNames: scenario.expected_trajectory } }
                  : {}),
                ...(scenario.turns.some(t => t.expectedResponse)
                  ? {
                      turns: scenario.turns.map(t => ({
                        input: { prompt: t.input },
                        ...(t.expectedResponse ? { expectedResponse: { text: t.expectedResponse } } : {}),
                      })),
                    }
                  : {}),
              },
            }
          : undefined,
      };
    }) as SessionMetadataEntry[];

    options.onProgress?.('invoking', `✓ ${successful.length} sessions ready for batch evaluation`);
    options.onProgress?.('ingesting', 'Waiting 180s for CloudWatch span ingestion...');
    await sleep(options.ingestionDelayMs ?? BATCH_INGESTION_DELAY_MS);

    return { success: true, sessionIds, sessionMetadata };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
