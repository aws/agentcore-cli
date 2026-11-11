import { contextKey } from "../../../router";

export type HarnessInvokeLaunchContext = {
  harnessId: string;
  userId?: string;
};

export const HarnessInvokeLaunchContextKey =
  contextKey<HarnessInvokeLaunchContext>("harness.invoke.launch");
