import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import { invokeHarnessTurn } from "../../harness/invoke/operation";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { selectProjectResource } from "./selection";

export const createProjectInvokeHarnessHandler = (
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "harness",
    description: "invoke a harness from the current project",
    flags: [
      flag("name", "the logical project harness name", z.string().optional()),
      flag("target", "project deployment target", z.string().default("default")),
      flag("prompt", "the message to send to the harness", z.string().optional()),
      flag(
        "session-id",
        "the Runtime session ID to continue (33-100 characters)",
        z.string().min(33).max(100).optional(),
      ),
      flag(
        "qualifier",
        "the harness endpoint qualifier to invoke (default DEFAULT)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const name = selectProjectResource(project, "harness", flags.name);
      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: flags.target,
        resourceType: "harness",
        name,
      });
      const invokeCtx = ctx.withValue(RegionKey, deployed.target.region);

      if (!flags.prompt) {
        if (invokeCtx.require(JsonKey)) {
          throw new InputValidationError("required option '--prompt <text>' not specified");
        }
        let path = `/agentcore/harness/invoke/${encodeURIComponent(deployed.id)}`;
        if (flags["session-id"]) path += `/${encodeURIComponent(flags["session-id"])}`;
        if (flags.qualifier) path += `?qualifier=${encodeURIComponent(flags.qualifier)}`;
        await renderInvokeTui(path, invokeCtx, core, io);
        return;
      }

      const result = await invokeHarnessTurn(
        core.harness,
        {
          harnessId: deployed.id,
          prompt: flags.prompt,
          qualifier: flags.qualifier,
          sessionId: flags["session-id"],
        },
        coreOptsFromCtx(invokeCtx),
      );
      invokeCtx.require(JsonRendererKey).renderJson(result);
    },
  });
