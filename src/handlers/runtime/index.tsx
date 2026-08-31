import z from "zod";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { flag, Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import type {
  ObservableResourceCommand,
  ObservabilityHandlerFactories,
} from "../observability/types";
import { createRuntimeEndpointHandler } from "./endpoint";
import { createGetRuntimeHandler } from "./get";
import { createInvokeRuntimeHandler } from "./invoke";
import { createListRuntimesHandler } from "./list";
import { runtimeIdSchema } from "./invoke/request";
import { resolveRuntimeTarget } from "./resolveRuntimeTarget";
import { createRuntimeTracesHandler } from "./traces";
import { createRuntimeVersionHandler } from "./version";

const runtimeObservabilityFlags = [
  flag(
    "id",
    "the ID of the Runtime (defaults to the project's deployed Runtime)",
    runtimeIdSchema.optional(),
  ),
  flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
] as const;

function runtimeObservabilityResource(
  core: Core,
): ObservableResourceCommand<"runtime", typeof runtimeObservabilityFlags> {
  return {
    flags: runtimeObservabilityFlags,
    resolve: async (flags, ctx) => {
      const target = await resolveRuntimeTarget(core, ctx, flags.id);
      return {
        resource: {
          kind: "runtime",
          id: target.runtimeId,
          ...(flags.qualifier ? { qualifier: flags.qualifier } : {}),
        },
        options: target.options,
      };
    },
  };
}

export function createRuntimeHandler(
  core: Core,
  io: AppIO,
  observabilityHandlers: ObservabilityHandlerFactories,
): Router {
  return new Router("runtime", "inspect AgentCore Runtimes")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list", "invoke", "version", "endpoint")
    .handler(createGetRuntimeHandler(core))
    .handler(createListRuntimesHandler(core))
    .handler(createInvokeRuntimeHandler(core, io))
    .handler(createRuntimeVersionHandler(core, io))
    .handler(createRuntimeEndpointHandler(core, io))
    .handler(
      observabilityHandlers.createLogsHandler({
        resource: runtimeObservabilityResource(core),
      }),
    )
    .handler(createRuntimeTracesHandler(core, io));
}
