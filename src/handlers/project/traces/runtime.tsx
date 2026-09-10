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

const projectRuntimeFlags = [
  flag("name", "the logical project Runtime name", z.string().optional()),
  flag("target", "project deployment target", z.string().min(1).default(DEFAULT_TARGET_NAME)),
  flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
] as const;

type ProjectRuntimeFlagValues = ResourceFlagValues<typeof projectRuntimeFlags>;

async function resolveProjectRuntime(core: Core, ctx: Context, flags: ProjectRuntimeFlagValues) {
  const project = ctx.require(ProjectKey);
  const name = selectProjectResource(project, "runtime", flags.name, "inspect traces for");
  const deployed = await core.projectManager.resolveDeployedResource(project, {
    target: flags.target,
    resourceType: "runtime",
    name,
  });

  return {
    source: {
      logGroupName: runtimeLogGroup(deployed.id, flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER),
    },
    options: {
      ...coreOptsFromCtx(ctx),
      region: deployed.target.region,
    },
  };
}

export function createProjectRuntimeTracesHandler(core: Core, io: AppIO): Router {
  const list = createListTracesHandler(io, {
    description: "list a Runtime's recent traces",
    flags: projectRuntimeFlags,
    read: async (ctx, flags, query, signal) => {
      const { source, options } = await resolveProjectRuntime(core, ctx, flags);
      return core.observability.listTraces(source, query, options, signal);
    },
  });
  const get = createGetTraceHandler(io, {
    description: "download a trace's log records to a JSON file",
    flags: projectRuntimeFlags,
    read: async (ctx, flags, query, signal) => {
      const { source, options } = await resolveProjectRuntime(core, ctx, flags);
      return core.observability.getTrace(source, query, options, signal);
    },
    resolveOutputPath: (_ctx, _flags, request) => resolveTraceOutputPath(request),
  });

  return new Router("runtime", "inspect a Runtime's traces").handler(list).handler(get);
}
