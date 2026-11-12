import { contextKey } from "../../../router";

export type HarnessInvokeLaunchContext = {
  harnessId: string;
  userId?: string;
};

export const HarnessInvokeLaunchContextKey =
  contextKey<HarnessInvokeLaunchContext>("harness.invoke.launch");

// HarnessInvokeArnKey carries the full ARN when `agentcore invoke --harness <arn>`
// delegates here. With a bearer token, the invoke then skips GetHarness, so a
// caller holding only a JWT needs no AWS credentials. `--id` takes only an ID.
export const HarnessInvokeArnKey = contextKey<string>("harness.invoke.arn");
