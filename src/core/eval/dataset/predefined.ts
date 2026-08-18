import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError } from "../../../errors";
import type { Example, RunContext } from "./types";

type Turn = { input: string; expectedResponse?: string };

// A predefined example has scripted turns: replay each verbatim, ignore the reply. Owns
// its parse (from the raw row) and its ground-truth mapping — everything predefined in
// one place.
export class PredefinedExample implements Example {
  readonly schemaType = "AGENTCORE_EVALUATION_PREDEFINED_V1" as const;
  readonly turns: Turn[];
  readonly assertions?: string[];
  readonly expectedTrajectory?: string[];

  // Parsing happens in the constructor (validation-at-boundary). Fields are assigned in
  // the body, not field initializers, so there's no "used before init" hazard.
  constructor(
    readonly exampleId: string,
    row: Record<string, unknown>,
  ) {
    const turns = (Array.isArray(row.turns) ? row.turns : []).map((t: Record<string, unknown>) => ({
      input: String(t.input ?? ""),
      expectedResponse: t.expected_response as string | undefined,
    }));
    if (turns.length === 0) {
      throw new InputValidationError(`example "${exampleId}" has no turns`);
    }
    this.turns = turns;
    this.assertions = row.assertions as string[] | undefined;
    this.expectedTrajectory = row.expected_trajectory as string[] | undefined;
  }

  // Turns share one session, so they run sequentially and awaited: racing them would
  // interleave the conversation and misalign the per-turn traces with the ground truth.
  async run(ctx: RunContext): Promise<InlineGroundTruth | undefined> {
    for (const turn of this.turns) await ctx.invokeOnce(turn.input);
    return this.groundTruth();
  }

  // One entry per turn, each carrying its prompt in `input`, so a turn with no expected
  // response still occupies its slot. Filtering the sparse turns out renumbers the rest,
  // scoring turn 3's expectation against turn 1; the service's alignment rule is
  // undocumented, so carrying the prompt is correct whether it aligns by index or content.
  private groundTruth(): InlineGroundTruth | undefined {
    const turns = this.turns.some((t) => t.expectedResponse !== undefined)
      ? this.turns.map((t) => ({
          input: { prompt: t.input },
          ...(t.expectedResponse !== undefined && {
            expectedResponse: { text: t.expectedResponse },
          }),
        }))
      : [];
    const assertions = this.assertions?.map((text) => ({ text }));
    const inline: InlineGroundTruth = {
      // Omit empty arrays: the service rejects zero-length `assertions`/`turns`
      // (documented min-1) rather than reading them as "no data".
      ...(assertions && assertions.length > 0 && { assertions }),
      ...(this.expectedTrajectory?.length && {
        expectedTrajectory: { toolNames: this.expectedTrajectory },
      }),
      ...(turns.length > 0 && { turns }),
    };
    // An all-empty inline is not "no ground truth" — return undefined so the caller omits it.
    return Object.keys(inline).length > 0 ? inline : undefined;
  }
}
