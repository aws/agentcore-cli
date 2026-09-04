import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../../core/observability";
import type { AppIO } from "../../../../io";
import { flag } from "../../../../router";
import { createListTracesHandler } from "../../../observability/traces";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const harnessFlags = [
  flag("id", "the ID of the harness", z.string().min(1).max(48)),
  flag("qualifier", "the harness endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createListHarnessTracesHandler = (core: Core, io: AppIO) =>
  createListTracesHandler(io, {
    description: "list a harness's recent traces",
    flags: harnessFlags,
    read: async (ctx, flags, query, signal) => {
      const options = coreOptsFromCtx(ctx);
      const runtime = await core.harness.resolveRuntime(flags.id, options, signal);
      const source = {
        logGroupName: runtimeLogGroup(
          runtime.runtimeId,
          flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
        ),
      };
      return core.observability.listTraces(source, query, options, signal);
    },
  });
