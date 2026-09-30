import { createContext } from "react";
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

export const RuntimeInvokeLaunchSessionContext = createContext({
  consumed: false,
  consume: () => {},
});
