import { contextKey } from "../../../router";

export type HarnessInvokeLaunchContext = {
  harnessId: string;
  userId?: string;
};

export const HarnessInvokeLaunchContextKey =
  contextKey<HarnessInvokeLaunchContext>("harness.invoke.launch");

// HarnessInvokeArnKey carries the full ARN when `agentcore invoke --harness <arn>`
// delegates here, so the invoke can skip GetHarness. `--id` takes only an ID.
export const HarnessInvokeArnKey = contextKey<string>("harness.invoke.arn");
