import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";
import { NotImplementedError } from "../../../errors";
import type { Example, RunContext } from "./types";

// A simulated example carries an actor profile instead of scripted turns: replaying it
// needs an LLM "user" to generate each next message from the agent's reply, which this
// command does not run yet. Throw at construction (= load time) so the user fails early
// with a clear message rather than a per-row "has no turns" misdiagnosis mid-run.
export class SimulatedExample implements Example {
  readonly schemaType = "AGENTCORE_EVALUATION_SIMULATED_V1" as const;

  constructor(
    readonly exampleId: string,
    _row: Record<string, unknown>,
  ) {
    throw new NotImplementedError(
      `example "${exampleId}" is a simulated example (actor_profile), which this ` +
        `command cannot replay yet — it has no scripted turns`,
    );
  }

  // Unreachable today (the constructor throws). Implements the interface; the actor loop
  // lands here when simulated ships.
  run(_ctx: RunContext): Promise<InlineGroundTruth | undefined> {
    throw new NotImplementedError("simulated example replay is not implemented");
  }
}
