import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGeneratePolicyHandler } from "./generate";

export function createGatewayPolicyHandler(core: Core, io: AppIO): Router {
  return new Router("policy", "generate Cedar policies for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("generate")
    .handler(createGeneratePolicyHandler(core, io));
}
