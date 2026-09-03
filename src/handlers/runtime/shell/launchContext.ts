import { contextKey } from "../../../router";

export type RuntimeShellLaunchContext = {
  runtimeId: string;
  runtimeSessionId?: string;
  bearerToken?: string;
};

export const RuntimeShellLaunchContextKey =
  contextKey<RuntimeShellLaunchContext>("runtime.shell.launch");
