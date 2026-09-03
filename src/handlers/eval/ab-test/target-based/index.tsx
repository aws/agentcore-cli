import { Router } from "../../../../router";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { createTargetBasedRunHandler } from "./run";

export function createTargetBasedAbTestHandler(core: Core, io: AppIO): Router {
  return new Router("target-based", "run target-based A/B tests").handler(
    createTargetBasedRunHandler(core, io),
  );
}
