import type { SessionMetadataShape } from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError } from "../../errors";

// Scenario is one dataset row for replay. Local to this module on purpose — it is
// not a handler contract, so it does not live in handlers/eval/types.tsx. Field
// names mirror the dataset JSONL (snake_case in, camelCase here).
export type Scenario = {
  scenarioId: string;
  turns: { input: string; expectedResponse?: string }[];
  assertions?: string[];
  expectedTrajectory?: string[];
};

// parseScenarios reads dataset JSONL (one scenario per line) into Scenario records.
// Each scenario needs a non-empty, unique `scenario_id` — the id is the join key
// between the session created for it and its ground truth, so a missing/duplicate
// id silently misassigns ground truth to the wrong session.
export function parseScenarios(text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new InputValidationError("dataset contains a line that is not valid JSON");
    }
    const scenario = toScenario(row);
    if (!scenario.scenarioId) {
      throw new InputValidationError("dataset scenario is missing 'scenario_id'");
    }
    if (seen.has(scenario.scenarioId)) {
      throw new InputValidationError(
        `dataset has a duplicate scenario_id: "${scenario.scenarioId}"`,
      );
    }
    if (scenario.turns.length === 0) {
      throw new InputValidationError(`scenario "${scenario.scenarioId}" has no turns`);
    }
    seen.add(scenario.scenarioId);
    scenarios.push(scenario);
  }
  if (scenarios.length === 0) throw new InputValidationError("dataset has no scenarios");
  return scenarios;
}

function toScenario(row: Record<string, unknown>): Scenario {
  const turns = Array.isArray(row.turns) ? row.turns : [];
  return {
    scenarioId: String(row.scenario_id ?? ""),
    turns: turns.map((t: Record<string, unknown>) => ({
      input: String(t.input ?? ""),
      expectedResponse: t.expected_response as string | undefined,
    })),
    assertions: row.assertions as string[] | undefined,
    expectedTrajectory: row.expected_trajectory as string[] | undefined,
  };
}

// loadDatasetFile reads scenarios from a local JSONL path. The dataset-id path is
// handled by the caller (downloadDataset to a temp file, then this).
export async function loadDatasetFile(path: string): Promise<Scenario[]> {
  return parseScenarios(await Bun.file(path).text());
}

// runScenarios runs `worker` over every scenario with bounded concurrency. A failed
// worker doesn't sink the run — the failure is captured (so the caller can report
// on all-failed) but drops that scenario. Returns ok results + the first error we
// saw, which the caller can surface to explain a total failure.
export type ScenarioRun<T> = { ok: T[]; failed: number; firstError?: Error };
export async function runScenarios<T>(
  scenarios: Scenario[],
  worker: (scenario: Scenario) => Promise<T>,
  concurrency = 5,
): Promise<ScenarioRun<T>> {
  const ok: T[] = [];
  let failed = 0;
  let firstError: Error | undefined;
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < scenarios.length) {
      const scenario = scenarios[next++]!;
      try {
        ok.push(await worker(scenario));
      } catch (error) {
        failed++;
        if (!firstError) firstError = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, run));
  return { ok, failed, firstError };
}

// toSessionMetadata maps a scenario's ground truth onto the session the replay
// created — the batch service's per-session ground-truth shape (inline arm).
// Omit array fields when empty: the service rejects zero-length `turns` /
// `assertions` (`length >= 1`) rather than treating an empty array as "no data".
export function toSessionMetadata(scenario: Scenario, sessionId: string): SessionMetadataShape {
  const turns = scenario.turns
    .filter((t) => t.expectedResponse !== undefined)
    .map((t) => ({ expectedResponse: { text: t.expectedResponse! } }));
  const assertions = scenario.assertions?.map((text) => ({ text }));
  return {
    sessionId,
    testScenarioId: scenario.scenarioId,
    groundTruth: {
      inline: {
        ...(assertions && assertions.length > 0 && { assertions }),
        ...(scenario.expectedTrajectory &&
          scenario.expectedTrajectory.length > 0 && {
            expectedTrajectory: { toolNames: scenario.expectedTrajectory },
          }),
        ...(turns.length > 0 && { turns }),
      },
    },
  };
}
