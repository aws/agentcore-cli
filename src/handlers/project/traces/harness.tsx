import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../core/observability/index";
import type { AppIO } from "../../../io";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { flag, ProjectKey, Router, type Context } from "../../../router";
import { createGetTraceHandler, createListTracesHandler } from "../../observability/traces";
import { resolveTraceOutputPath } from "../../observability/traceOutputPath";
import type { ResourceFlagValues } from "../../observability/types";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { selectProjectResource } from "../selection";

const projectHarnessFlags = [
  flag("name", "the logical project Harness name", z.string().optional()),
  flag("target", "project deployment target", z.string().min(1).default(DEFAULT_TARGET_NAME)),
  flag("qualifier", "the Harness endpoint qualifier", z.string().min(1).optional()),
] as const;

type ProjectHarnessFlagValues = ResourceFlagValues<typeof projectHarnessFlags>;

async function resolveProjectHarness(
  core: Core,
  ctx: Context,
  flags: ProjectHarnessFlagValues,
  signal: AbortSignal,
) {
  const project = ctx.require(ProjectKey);
  const name = selectProjectResource(project, "harness", flags.name, "inspect traces for");
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

  return {
    source: {
      logGroupName: runtimeLogGroup(
        runtime.runtimeId,
        flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
      ),
    },
    options,
  };
}

export function createProjectHarnessTracesHandler(core: Core, io: AppIO): Router {
  const list = createListTracesHandler(io, {
    description: "list a Harness's recent traces",
    flags: projectHarnessFlags,
    read: async (ctx, flags, query, signal) => {
      const { source, options } = await resolveProjectHarness(core, ctx, flags, signal);
      return core.observability.listTraces(source, query, options, signal);
    },
  });
  const get = createGetTraceHandler(io, {
    description: "download a Harness trace's log records to a JSON file",
    flags: projectHarnessFlags,
    read: async (ctx, flags, query, signal) => {
      const { source, options } = await resolveProjectHarness(core, ctx, flags, signal);
      return core.observability.getTrace(source, query, options, signal);
    },
    resolveOutputPath: (_ctx, _flags, request) => resolveTraceOutputPath(request),
  });

  return new Router("harness", "inspect a Harness's traces").handler(list).handler(get);
}
