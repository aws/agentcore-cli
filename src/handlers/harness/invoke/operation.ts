import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
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

export async function foldHarnessTurn(
  prompt: string,
  sessionId: string,
  events: AsyncIterable<InvokeHarnessStreamOutput>,
): Promise<HarnessInvokeResult> {
  const turn = newTurn();
  for await (const event of events) applyEvent(turn, event);
  finishTurn(turn);
  return {
    sessionId,
    stopReason: turn.stopReason,
    usage: turn.usage,
    latencyMs: turn.latencyMs,
    transcript: [{ kind: "user", text: prompt }, ...turn.items],
  };
}

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

  return foldHarnessTurn(input.prompt, sessionId, response.stream ?? (async function* () {})());
}
