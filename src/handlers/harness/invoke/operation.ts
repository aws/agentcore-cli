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
    prompt: string;
    qualifier?: string;
    sessionId?: string;
  },
  options: CoreOptions,
  signal?: AbortSignal,
): Promise<HarnessInvokeResult> {
  const detail = await client.getHarness(input.harnessId, options);
  const sessionId = input.sessionId ?? newSessionId();
  const response = await client.invokeHarness(
    {
      harnessArn: detail.harness?.arn,
      qualifier: input.qualifier ?? "DEFAULT",
      runtimeSessionId: sessionId,
      messages: [{ role: "user", content: [{ text: input.prompt }] }],
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
