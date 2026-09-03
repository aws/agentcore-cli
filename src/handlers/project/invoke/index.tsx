import type { AppIO } from "../../../io";
import { InputValidationError } from "../../../errors";
import { Router } from "../../../router";
import { renderTuiAt } from "../../../tui";
import { withProject } from "../../../middleware";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { createProjectInvokeHarnessHandler } from "./harness";
import { createProjectInvokeRuntimeHandler } from "./runtime";

export function createProjectInvokeHandler(
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
): Router {
  return new Router("invoke", "invoke a Runtime or harness from the current project")
    .use(withProject({ projectManager: core.projectManager }))
    .handler(createProjectInvokeRuntimeHandler(core, io, renderInvokeTui))
    .handler(createProjectInvokeHarnessHandler(core, io, renderInvokeTui))
    .default((ctx) => {
      if (ctx.require(JsonKey)) {
        throw new InputValidationError(
          "a Runtime or Harness invoke subcommand is required with --json",
        );
      }
      return renderInvokeTui("/agentcore/project/invoke", ctx, core, io);
    });
}
