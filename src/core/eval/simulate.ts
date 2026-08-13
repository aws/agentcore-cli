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
export function parseScenarios(text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new InputValidationError("dataset contains a line that is not valid JSON");
    }
    scenarios.push(toScenario(row));
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

// runScenarios runs `worker` over every scenario with bounded concurrency, dropping
// failures (a single bad invocation must not sink the run). Returns the successful
// results plus a failure count so the caller can warn / error on all-failed.
export async function runScenarios<T>(
  scenarios: Scenario[],
  worker: (scenario: Scenario) => Promise<T>,
  concurrency = 5,
): Promise<{ ok: T[]; failed: number }> {
  const ok: T[] = [];
  let failed = 0;
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < scenarios.length) {
      const scenario = scenarios[next++]!;
      try {
        ok.push(await worker(scenario));
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, run));
  return { ok, failed };
}

// toSessionMetadata maps a scenario's ground truth onto the session the replay
// created — the batch service's per-session ground-truth shape (inline arm).
export function toSessionMetadata(scenario: Scenario, sessionId: string): SessionMetadataShape {
  return {
    sessionId,
    testScenarioId: scenario.scenarioId,
    groundTruth: {
      inline: {
        assertions: scenario.assertions?.map((text) => ({ text })),
        expectedTrajectory: scenario.expectedTrajectory
          ? { toolNames: scenario.expectedTrajectory }
          : undefined,
        turns: scenario.turns
          .filter((t) => t.expectedResponse !== undefined)
          .map((t) => ({ expectedResponse: { text: t.expectedResponse! } })),
      },
    },
  };
}
