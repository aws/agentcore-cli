import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError } from "../../../../errors";
import type { Example, RunContext } from "./types";

type Turn = { input: string; expectedResponse?: string };

export class PredefinedExample implements Example {
  readonly schemaType = "AGENTCORE_EVALUATION_PREDEFINED_V1" as const;
  readonly turns: Turn[];
  readonly assertions?: string[];
  readonly expectedTrajectory?: string[];

  constructor(
    readonly exampleId: string,
    row: Record<string, unknown>,
  ) {
    const turns = (Array.isArray(row.turns) ? row.turns : []).map((t: unknown, i: number) => {
      // Reject a non-object entry here; dereferencing it below would throw a raw TypeError.
      if (typeof t !== "object" || t === null) {
        throw new InputValidationError(`example "${exampleId}" turn ${i + 1} is not an object`);
      }
      const turn = t as Record<string, unknown>;
      return {
        input: String(turn.input ?? ""),
        expectedResponse: turn.expected_response as string | undefined,
      };
    });
    if (turns.length === 0) {
      throw new InputValidationError(`example "${exampleId}" has no turns`);
    }
    this.turns = turns;
    this.assertions = row.assertions as string[] | undefined;
    this.expectedTrajectory = row.expected_trajectory as string[] | undefined;
  }

  // Sequential and awaited: the turns share one session, so racing them would interleave
  // the conversation and misalign per-turn traces with the ground truth.
  async run(ctx: RunContext): Promise<InlineGroundTruth | undefined> {
    for (const turn of this.turns) await ctx.invokeOnce(turn.input);
    return this.groundTruth();
  }

  // Emit every turn (carrying its prompt), not just those with an expectation: filtering
  // renumbers the rest, scoring turn 3's expectation against turn 1. The service's
  // alignment rule is undocumented, so the prompt keeps index and content matching both valid.
  private groundTruth(): InlineGroundTruth | undefined {
    // Empty expected_response means no expectation: the service rejects a zero-length
    // expectedResponse.text (min 1), so treat "" the same as an omitted field.
    const turns = this.turns.some((t) => t.expectedResponse)
      ? this.turns.map((t) => ({
          input: { prompt: t.input },
          ...(t.expectedResponse && { expectedResponse: { text: t.expectedResponse } }),
        }))
      : [];
    const assertions = this.assertions?.map((text) => ({ text }));
    const inline: InlineGroundTruth = {
      // Omit empty arrays — the service rejects zero-length assertions/turns (min-1).
      ...(assertions && assertions.length > 0 && { assertions }),
      ...(this.expectedTrajectory?.length && {
        expectedTrajectory: { toolNames: this.expectedTrajectory },
      }),
      ...(turns.length > 0 && { turns }),
    };
    return Object.keys(inline).length > 0 ? inline : undefined;
  }
}
