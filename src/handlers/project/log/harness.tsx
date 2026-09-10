import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../core/observability/index";
import type { AppIO } from "../../../io";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { flag, ProjectKey } from "../../../router";
import { createLogsHandler } from "../../observability/logs";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { selectProjectResource } from "../selection";

const projectHarnessFlags = [
  flag("name", "the logical project Harness name", z.string().optional()),
  flag("target", "project deployment target", z.string().min(1).default(DEFAULT_TARGET_NAME)),
  flag("qualifier", "the Harness endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createProjectHarnessLogHandler = (core: Core, io: AppIO) =>
  createLogsHandler(io, {
    name: "harness",
    description: "stream or search logs for a Harness in the current project",
    flags: projectHarnessFlags,
    read: async (ctx, flags, request, signal) => {
      const project = ctx.require(ProjectKey);
      const name = selectProjectResource(project, "harness", flags.name, "inspect logs for");
      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: flags.target,
        resourceType: "harness",
        name,
      });
      const options = {
        ...coreOptsFromCtx(ctx),
        region: deployed.target.region,
      };
      const runtime = await core.harness.resolveRuntime(deployed.id, options, signal);
      const source = {
        logGroupName: runtimeLogGroup(
          runtime.runtimeId,
          flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
        ),
      };

      if (request.mode === "search") {
        return {
          events: core.observability.searchLogs(source, request.query, options, signal),
        };
      }

      return {
        events: core.observability.tailLogs(source, request.query, options, signal),
        announcement:
          `Streaming logs for Harness '${name}' on target '${deployed.target.name}'... ` +
          "(Ctrl+C to stop)",
      };
    },
  });
