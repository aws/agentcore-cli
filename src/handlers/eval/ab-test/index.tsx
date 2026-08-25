import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetAbTestHandler } from "./get";
import { createListAbTestsHandler } from "./list";
import { createPauseAbTestHandler } from "./pause";
import { createResumeAbTestHandler } from "./resume";
import { createStopAbTestHandler } from "./stop";
import { createDeleteAbTestHandler } from "./delete";

export function createAbTestHandler(core: Core, io: AppIO): Router {
  return new Router("ab-test", "inspect AgentCore A/B tests")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createGetAbTestHandler(core, io))
    .handler(createListAbTestsHandler(core))
    .handler(createPauseAbTestHandler(core))
    .handler(createResumeAbTestHandler(core))
    .handler(createStopAbTestHandler(core))
    .handler(createDeleteAbTestHandler(core));
}

export { AbTestScreen } from "./screen.tsx";
