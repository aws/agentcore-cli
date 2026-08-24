import { contextKey } from "../../../router";

export type GatewayInvokeLaunchContext = {
  gatewayId: string;
  path?: string;
  runtimeSessionId?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
};

export const GatewayInvokeLaunchContextKey =
  contextKey<GatewayInvokeLaunchContext>("gateway.invoke.launch");
