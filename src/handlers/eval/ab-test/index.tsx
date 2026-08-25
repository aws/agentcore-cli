import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetAbTestHandler } from "./get";
import { createListAbTestsHandler } from "./list";

export function createAbTestHandler(core: Core, io: AppIO): Router {
  return new Router("ab-test", "inspect AgentCore A/B tests")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createGetAbTestHandler(core, io))
    .handler(createListAbTestsHandler(core));
}
