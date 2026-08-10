import { contextKey } from "../../../router";

export type RuntimeInvokeLaunchContext = {
  runtimeId: string;
  runtimeSessionId?: string;
  runtimeUserId?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
};

export const RuntimeInvokeLaunchContextKey =
  contextKey<RuntimeInvokeLaunchContext>("runtime.invoke.launch");
