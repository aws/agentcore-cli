import { Router } from "../../../../router";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { createConfigBasedRunHandler } from "./run";

export function createConfigBasedAbTestHandler(core: Core, io: AppIO): Router {
  return new Router("config-based", "config-based A/B tests").handler(
    createConfigBasedRunHandler(core, io),
  );
}
