import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../../core/observability";
import type { AppIO } from "../../../../io";
import { flag } from "../../../../router";
import { createListTracesHandler } from "../../../observability/traces";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { runtimeIdSchema } from "../../invoke/request";

const runtimeFlags = [
  flag("id", "the ID of the Runtime", runtimeIdSchema),
  flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createListRuntimeTracesHandler = (core: Core, io: AppIO) =>
  createListTracesHandler(io, {
    description: "list a Runtime's recent traces",
    flags: runtimeFlags,
    read: (ctx, flags, query, signal) => {
      const source = {
        logGroupName: runtimeLogGroup(flags.id, flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER),
      };
      return core.observability.listTraces(source, query, coreOptsFromCtx(ctx), signal);
    },
  });
