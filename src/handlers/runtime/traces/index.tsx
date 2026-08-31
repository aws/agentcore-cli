import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetRuntimeTraceHandler } from "./get";
import { createListRuntimeTracesHandler } from "./list";

// The default window traces commands look back over when --since is omitted,
// matching the old CLI's 12h Insights lookback.
export const DEFAULT_TRACES_WINDOW_MS = 12 * 3_600_000;

export function createRuntimeTracesHandler(core: Core, io: AppIO): Router {
  return new Router("traces", "inspect a Runtime's traces")
    .handler(createListRuntimeTracesHandler(core, io))
    .handler(createGetRuntimeTraceHandler(core, io));
}
