import type { AgentCoreGateway } from "../../projectSchemas/gateway";
import { getBoxGatewayBedrockTargetSpec, getBoxGatewayEntry } from "./shortcuts";

/**
 * The entry a Bedrock agent's Box gateway, `<runtime>-box`, has after a build in us-west-2: the
 * passthrough target for the Bedrock model endpoint. `agentcore create` declares the entry with no
 * target, and build adds this one for the region it builds for.
 */
export function getBoxGatewayBedrockEntry(runtimeName: string): AgentCoreGateway {
  return { ...getBoxGatewayEntry(runtimeName), targets: [getBoxGatewayBedrockTargetSpec()] };
}
