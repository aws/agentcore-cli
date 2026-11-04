import type { CoreOptions } from "../../../core/types";
import type { CoreHarnessClient } from "../types";
import { applyEvent, finishTurn, newSessionId, newTurn, type TranscriptItem } from "./transcript";

export type HarnessInvokeResult = {
  sessionId: string;
  stopReason?: string;
  usage?: ReturnType<typeof newTurn>["usage"];
  latencyMs?: number;
  transcript: TranscriptItem[];
};

export async function invokeHarnessTurn(
  client: CoreHarnessClient,
  input: {
    harnessId: string;
    // A caller that already holds the ARN skips the GetHarness lookup, which is
    // what lets a bearer-token invoke run without AWS credentials.
    harnessArn?: string;
    prompt: string;
    qualifier?: string;
    sessionId?: string;
    userId?: string;
    bearerToken?: string;
  },
  options: CoreOptions,
  signal?: AbortSignal,
): Promise<HarnessInvokeResult> {
  const harnessArn =
    input.harnessArn ?? (await client.getHarness(input.harnessId, options)).harness?.arn;
  const sessionId = input.sessionId ?? newSessionId();
  const response = await client.invokeHarness(
    {
      harnessArn,
      qualifier: input.qualifier ?? "DEFAULT",
      runtimeSessionId: sessionId,
      runtimeUserId: input.userId,
      messages: [{ role: "user", content: [{ text: input.prompt }] }],
      ...(input.bearerToken !== undefined && { bearerToken: input.bearerToken }),
    },
    options,
    signal,
  );

  const turn = newTurn();
  for await (const event of response.stream ?? []) applyEvent(turn, event);
  finishTurn(turn);

  return {
    sessionId,
    stopReason: turn.stopReason,
    usage: turn.usage,
    latencyMs: turn.latencyMs,
    transcript: [{ kind: "user", text: input.prompt }, ...turn.items],
  };
}
