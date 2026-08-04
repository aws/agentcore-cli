import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetMemoryRecordHandler } from "./get";
import { createListMemoryRecordsHandler } from "./list";

export function createMemoryRecordHandler(core: Core, io: AppIO): Router {
  return new Router("record", "inspect AgentCore Memory records")
    .default(renderTui(core, io))
    .handler(createGetMemoryRecordHandler(core))
    .handler(createListMemoryRecordsHandler(core));
}
