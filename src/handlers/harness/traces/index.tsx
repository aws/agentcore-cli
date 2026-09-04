import type { AppIO } from "../../../io";
import { createTracesHandler } from "../../observability/traces";
import type { Core } from "../../types";
import { createGetHarnessTraceHandler } from "./get";
import { createListHarnessTracesHandler } from "./list";

export const createHarnessTracesHandler = (core: Core, io: AppIO) =>
  createTracesHandler({
    description: "inspect a harness's traces",
    list: createListHarnessTracesHandler(core, io),
    get: createGetHarnessTraceHandler(core, io),
  });
