import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import type { Core } from "../../types";
import { createGeneratePolicyHandler } from "./generate";

export function createGatewayPolicyHandler(core: Core, io: AppIO): Router {
  return new Router("policy", "generate Cedar policies for an AgentCore Gateway").handler(
    createGeneratePolicyHandler(core, io),
  );
}
