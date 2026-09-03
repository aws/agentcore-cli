import type { AppIO } from "../../../io";
import { createTracesHandler } from "../../observability/traces";
import type { Core } from "../../types";
import { createGetRuntimeTraceHandler } from "./get";
import { createListRuntimeTracesHandler } from "./list";

export const createRuntimeTracesHandler = (core: Core, io: AppIO) =>
  createTracesHandler({
    description: "inspect a Runtime's traces",
    list: createListRuntimeTracesHandler(core, io),
    get: createGetRuntimeTraceHandler(core, io),
  });
