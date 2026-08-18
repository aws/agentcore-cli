import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";
import { NotImplementedError } from "../../../../errors";
import type { Example, RunContext } from "./types";

// Not shipped: replaying a simulated example needs an LLM actor we don't run yet. Throw
// at construction (= load time) so the user fails early, not with a per-row misdiagnosis.
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

  run(_ctx: RunContext): Promise<InlineGroundTruth | undefined> {
    throw new NotImplementedError("simulated example replay is not implemented");
  }
}
